from fastapi import FastAPI, APIRouter, HTTPException, Query
from fastapi.responses import RedirectResponse, JSONResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field, ConfigDict
from typing import List, Optional
import uuid
from datetime import datetime, timezone, timedelta
import requests
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from google.auth.transport.requests import Request as GoogleRequest

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# Google OAuth Config
GOOGLE_CLIENT_ID = os.environ.get('GOOGLE_CLIENT_ID', '')
GOOGLE_CLIENT_SECRET = os.environ.get('GOOGLE_CLIENT_SECRET', '')
GOOGLE_REDIRECT_URI = os.environ.get('GOOGLE_REDIRECT_URI', '')
GOOGLE_AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token"
GOOGLE_SCOPES = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/userinfo.email"
]

# Create the main app without a prefix
app = FastAPI()

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


# Define Models
class AlarmSetting(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    email: str
    event_id: str
    event_title: str
    event_start: str
    alarm_minutes_before: int  # Custom minutes before event
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class AlarmSettingCreate(BaseModel):
    email: str
    event_id: str
    event_title: str
    event_start: str
    alarm_minutes_before: int


# Helper function to get credentials
async def get_google_credentials(email: str):
    user = await db.users.find_one({"email": email})
    if not user or 'google_tokens' not in user:
        raise HTTPException(status_code=401, detail="User not authenticated with Google")
    
    tokens = user['google_tokens']
    creds = Credentials(
        token=tokens.get('access_token'),
        refresh_token=tokens.get('refresh_token'),
        token_uri=GOOGLE_TOKEN_URI,
        client_id=GOOGLE_CLIENT_ID,
        client_secret=GOOGLE_CLIENT_SECRET,
        scopes=GOOGLE_SCOPES
    )
    
    # Auto-refresh if expired
    if creds.expired and creds.refresh_token:
        try:
            creds.refresh(GoogleRequest())
            # Update tokens in DB
            await db.users.update_one(
                {"email": email},
                {"$set": {"google_tokens.access_token": creds.token}}
            )
        except Exception as e:
            logger.error(f"Token refresh failed: {e}")
            raise HTTPException(status_code=401, detail="Token refresh failed")
    
    return creds


# Routes
@api_router.get("/")
async def root():
    return {"message": "Google Calendar Alarm API"}


@api_router.get("/auth/google/login")
async def google_login():
    """Initiate Google OAuth flow"""
    if not GOOGLE_CLIENT_ID or GOOGLE_CLIENT_ID == 'YOUR_GOOGLE_CLIENT_ID_HERE':
        raise HTTPException(
            status_code=500,
            detail="Google OAuth not configured. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend/.env"
        )
    
    # Build authorization URL
    params = {
        'client_id': GOOGLE_CLIENT_ID,
        'redirect_uri': GOOGLE_REDIRECT_URI,
        'response_type': 'code',
        'scope': ' '.join(GOOGLE_SCOPES),
        'access_type': 'offline',
        'prompt': 'consent'
    }
    
    auth_url = f"{GOOGLE_AUTH_URI}?" + "&".join([f"{k}={v}" for k, v in params.items()])
    return {"authorization_url": auth_url}


@api_router.get("/auth/google/callback")
async def google_callback(code: str = Query(...)):
    """Handle Google OAuth callback"""
    try:
        # Exchange code for tokens
        token_response = requests.post(
            GOOGLE_TOKEN_URI,
            data={
                'code': code,
                'client_id': GOOGLE_CLIENT_ID,
                'client_secret': GOOGLE_CLIENT_SECRET,
                'redirect_uri': GOOGLE_REDIRECT_URI,
                'grant_type': 'authorization_code'
            }
        )
        
        if token_response.status_code != 200:
            raise HTTPException(status_code=400, detail="Failed to exchange code for tokens")
        
        tokens = token_response.json()
        
        # Get user info
        user_info_response = requests.get(
            'https://www.googleapis.com/oauth2/v2/userinfo',
            headers={'Authorization': f'Bearer {tokens["access_token"]}'}
        )
        
        if user_info_response.status_code != 200:
            raise HTTPException(status_code=400, detail="Failed to get user info")
        
        user_info = user_info_response.json()
        email = user_info['email']
        
        # Save tokens in database
        await db.users.update_one(
            {"email": email},
            {
                "$set": {
                    "email": email,
                    "google_tokens": tokens,
                    "updated_at": datetime.now(timezone.utc).isoformat()
                }
            },
            upsert=True
        )
        
        # Redirect to frontend dashboard
        frontend_url = os.environ.get('CORS_ORIGINS', 'http://localhost:3000').split(',')[0]
        if frontend_url == '*':
            frontend_url = 'https://calendaralarm.preview.emergentagent.com'
        
        return RedirectResponse(url=f"{frontend_url}/?email={email}&auth=success")
    
    except Exception as e:
        logger.error(f"OAuth callback error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@api_router.get("/calendar/events")
async def get_calendar_events(email: str = Query(...)):
    """Fetch upcoming calendar events"""
    try:
        creds = await get_google_credentials(email)
        service = build('calendar', 'v3', credentials=creds)
        
        # Get events from now to 30 days ahead
        now = datetime.now(timezone.utc).isoformat()
        time_max = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
        
        events_result = service.events().list(
            calendarId='primary',
            timeMin=now,
            timeMax=time_max,
            maxResults=50,
            singleEvents=True,
            orderBy='startTime'
        ).execute()
        
        events = events_result.get('items', [])
        
        # Format events
        formatted_events = []
        for event in events:
            start = event.get('start', {}).get('dateTime', event.get('start', {}).get('date'))
            end = event.get('end', {}).get('dateTime', event.get('end', {}).get('date'))
            
            formatted_events.append({
                'id': event.get('id'),
                'title': event.get('summary', 'No Title'),
                'description': event.get('description', ''),
                'start': start,
                'end': end,
                'location': event.get('location', ''),
                'htmlLink': event.get('htmlLink', '')
            })
        
        return {"events": formatted_events}
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error fetching calendar events: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@api_router.post("/alarms", response_model=AlarmSetting)
async def create_alarm(alarm: AlarmSettingCreate):
    """Create or update an alarm for a calendar event"""
    try:
        # Check if alarm already exists for this event
        existing = await db.alarms.find_one({
            "email": alarm.email,
            "event_id": alarm.event_id
        })
        
        alarm_obj = AlarmSetting(**alarm.model_dump())
        doc = alarm_obj.model_dump()
        doc['created_at'] = doc['created_at'].isoformat()
        
        if existing:
            # Update existing alarm
            await db.alarms.update_one(
                {"email": alarm.email, "event_id": alarm.event_id},
                {"$set": doc}
            )
        else:
            # Create new alarm
            await db.alarms.insert_one(doc)
        
        return alarm_obj
    
    except Exception as e:
        logger.error(f"Error creating alarm: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@api_router.get("/alarms", response_model=List[AlarmSetting])
async def get_alarms(email: str = Query(...)):
    """Get all alarms for a user"""
    try:
        alarms = await db.alarms.find({"email": email}, {"_id": 0}).to_list(1000)
        
        # Convert ISO strings back to datetime
        for alarm in alarms:
            if isinstance(alarm.get('created_at'), str):
                alarm['created_at'] = datetime.fromisoformat(alarm['created_at'])
        
        return alarms
    
    except Exception as e:
        logger.error(f"Error fetching alarms: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@api_router.delete("/alarms/{alarm_id}")
async def delete_alarm(alarm_id: str, email: str = Query(...)):
    """Delete an alarm"""
    try:
        result = await db.alarms.delete_one({"id": alarm_id, "email": email})
        
        if result.deleted_count == 0:
            raise HTTPException(status_code=404, detail="Alarm not found")
        
        return {"message": "Alarm deleted successfully"}
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting alarm: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@api_router.get("/auth/status")
async def check_auth_status(email: str = Query(...)):
    """Check if user is authenticated"""
    user = await db.users.find_one({"email": email})
    
    if user and 'google_tokens' in user:
        return {"authenticated": True, "email": email}
    
    return {"authenticated": False}


# Include the router in the main app
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()