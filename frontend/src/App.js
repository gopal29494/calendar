import { useState, useEffect, useRef } from "react";
import "@/App.css";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Calendar, Clock, Bell, Trash2, AlertCircle } from "lucide-react";
import { toast } from "sonner";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

function App() {
  const [email, setEmail] = useState("");
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [events, setEvents] = useState([]);
  const [alarms, setAlarms] = useState([]);
  const [loading, setLoading] = useState(false);
  const [alarmSettings, setAlarmSettings] = useState({});
  const audioRef = useRef(null);
  const alarmCheckIntervalRef = useRef(null);

  // Check URL params for OAuth callback
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const emailParam = params.get('email');
    const authSuccess = params.get('auth');

    if (emailParam && authSuccess === 'success') {
      setEmail(emailParam);
      localStorage.setItem('userEmail', emailParam);
      setIsAuthenticated(true);
      toast.success('Successfully connected to Google Calendar!');
      // Clean URL
      window.history.replaceState({}, document.title, '/');
    } else {
      // Check localStorage
      const savedEmail = localStorage.getItem('userEmail');
      if (savedEmail) {
        setEmail(savedEmail);
        checkAuthStatus(savedEmail);
      }
    }
  }, []);

  // Load events and alarms when authenticated
  useEffect(() => {
    if (isAuthenticated && email) {
      loadCalendarEvents();
      loadAlarms();
    }
  }, [isAuthenticated, email]);

  // Start alarm monitoring
  useEffect(() => {
    if (isAuthenticated && alarms.length > 0) {
      startAlarmMonitoring();
    }

    return () => {
      if (alarmCheckIntervalRef.current) {
        clearInterval(alarmCheckIntervalRef.current);
      }
    };
  }, [alarms, isAuthenticated]);

  const checkAuthStatus = async (userEmail) => {
    try {
      const response = await axios.get(`${API}/auth/status?email=${userEmail}`);
      if (response.data.authenticated) {
        setIsAuthenticated(true);
      } else {
        localStorage.removeItem('userEmail');
      }
    } catch (error) {
      console.error('Error checking auth status:', error);
      localStorage.removeItem('userEmail');
    }
  };

  const handleGoogleLogin = async () => {
    try {
      setLoading(true);
      const response = await axios.get(`${API}/auth/google/login`);
      window.location.href = response.data.authorization_url;
    } catch (error) {
      console.error('Login error:', error);
      toast.error(error.response?.data?.detail || 'Failed to initiate Google login');
      setLoading(false);
    }
  };

  const loadCalendarEvents = async () => {
    try {
      setLoading(true);
      const response = await axios.get(`${API}/calendar/events?email=${email}`);
      setEvents(response.data.events);
    } catch (error) {
      console.error('Error loading events:', error);
      toast.error('Failed to load calendar events');
    } finally {
      setLoading(false);
    }
  };

  const loadAlarms = async () => {
    try {
      const response = await axios.get(`${API}/alarms?email=${email}`);
      setAlarms(response.data);
    } catch (error) {
      console.error('Error loading alarms:', error);
    }
  };

  const handleSetAlarm = async (event) => {
    const minutes = alarmSettings[event.id];
    if (!minutes || minutes < 1) {
      toast.error('Please enter valid minutes (minimum 1)');
      return;
    }

    try {
      await axios.post(`${API}/alarms`, {
        email,
        event_id: event.id,
        event_title: event.title,
        event_start: event.start,
        alarm_minutes_before: parseInt(minutes)
      });

      toast.success(`Alarm set for ${minutes} minutes before "${event.title}"`);
      loadAlarms();
    } catch (error) {
      console.error('Error setting alarm:', error);
      toast.error('Failed to set alarm');
    }
  };

  const handleDeleteAlarm = async (alarmId) => {
    try {
      await axios.delete(`${API}/alarms/${alarmId}?email=${email}`);
      toast.success('Alarm deleted');
      loadAlarms();
    } catch (error) {
      console.error('Error deleting alarm:', error);
      toast.error('Failed to delete alarm');
    }
  };

  const getAlarmForEvent = (eventId) => {
    return alarms.find(alarm => alarm.event_id === eventId);
  };

  const startAlarmMonitoring = () => {
    // Clear existing interval
    if (alarmCheckIntervalRef.current) {
      clearInterval(alarmCheckIntervalRef.current);
    }

    // Check alarms every 10 seconds
    alarmCheckIntervalRef.current = setInterval(() => {
      checkAlarms();
    }, 10000);

    // Check immediately
    checkAlarms();
  };

  const checkAlarms = () => {
    const now = new Date();

    alarms.forEach(alarm => {
      const eventTime = new Date(alarm.event_start);
      const alarmTime = new Date(eventTime.getTime() - alarm.alarm_minutes_before * 60000);

      // If alarm time has passed and event hasn't started yet
      if (now >= alarmTime && now < eventTime) {
        // Check if this alarm was already triggered (using localStorage)
        const triggeredKey = `alarm_triggered_${alarm.id}`;
        if (!localStorage.getItem(triggeredKey)) {
          triggerAlarm(alarm);
          localStorage.setItem(triggeredKey, 'true');
        }
      }
    });
  };

  const triggerAlarm = (alarm) => {
    // Play audio
    if (audioRef.current) {
      audioRef.current.play().catch(err => console.error('Audio play error:', err));
    }

    // Show notification
    toast.error(
      `⏰ ALARM: "${alarm.event_title}" starts in ${alarm.alarm_minutes_before} minutes!`,
      {
        duration: 10000,
        position: 'top-center'
      }
    );

    // Browser notification if permitted
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('Calendar Alarm', {
        body: `${alarm.event_title} starts in ${alarm.alarm_minutes_before} minutes!`,
        icon: '/calendar-icon.png',
        requireInteraction: true
      });
    }
  };

  const requestNotificationPermission = async () => {
    if ('Notification' in window && Notification.permission === 'default') {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        toast.success('Browser notifications enabled!');
      }
    }
  };

  const formatDateTime = (dateTimeStr) => {
    const date = new Date(dateTimeStr);
    return date.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const handleLogout = () => {
    localStorage.removeItem('userEmail');
    setEmail('');
    setIsAuthenticated(false);
    setEvents([]);
    setAlarms([]);
    toast.success('Logged out successfully');
  };

  if (!isAuthenticated) {
    return (
      <div className="landing-page">
        <div className="landing-content">
          <div className="hero-section">
            <div className="alarm-icon-large">
              <Bell size={80} />
            </div>
            <h1 className="hero-title">
              Never Miss a Meeting Again
            </h1>
            <p className="hero-subtitle">
              Set custom audio alarms for your Google Calendar events.<br/>
              Stay on time, every time.
            </p>
            <Button
              data-testid="connect-google-btn"
              onClick={handleGoogleLogin}
              disabled={loading}
              className="connect-button"
              size="lg"
            >
              <Calendar className="mr-2" size={20} />
              {loading ? 'Connecting...' : 'Connect Google Calendar'}
            </Button>
          </div>

          <div className="features-section">
            <div className="feature-card">
              <Clock size={40} className="feature-icon" />
              <h3>Custom Timing</h3>
              <p>Set your own reminder time for each meeting</p>
            </div>
            <div className="feature-card">
              <Bell size={40} className="feature-icon" />
              <h3>Audio Alarms</h3>
              <p>Loud audio notifications that you can't miss</p>
            </div>
            <div className="feature-card">
              <Calendar size={40} className="feature-icon" />
              <h3>Auto Sync</h3>
              <p>Seamlessly syncs with your Google Calendar</p>
            </div>
          </div>
        </div>

        {/* Hidden audio element for alarm sound */}
        <audio
          ref={audioRef}
          src="https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3"
          loop
        />
      </div>
    );
  }

  return (
    <div className="dashboard-page">
      <header className="dashboard-header">
        <div className="header-content">
          <div className="header-left">
            <Bell size={32} className="logo-icon" />
            <h1 className="app-title">Calendar Alarms</h1>
          </div>
          <div className="header-right">
            <Badge variant="outline" className="email-badge">{email}</Badge>
            <Button
              variant="outline"
              onClick={requestNotificationPermission}
              size="sm"
              className="mr-2"
            >
              Enable Notifications
            </Button>
            <Button
              variant="destructive"
              onClick={handleLogout}
              size="sm"
            >
              Logout
            </Button>
          </div>
        </div>
      </header>

      <main className="dashboard-main" data-testid="dashboard-main">
        {loading ? (
          <div className="loading-state">
            <div className="spinner"></div>
            <p>Loading your calendar...</p>
          </div>
        ) : (
          <>
            {events.length === 0 ? (
              <Card className="empty-state-card">
                <CardContent className="empty-state-content">
                  <AlertCircle size={60} className="empty-icon" />
                  <h3>No upcoming events</h3>
                  <p>Your calendar is clear for the next 30 days</p>
                </CardContent>
              </Card>
            ) : (
              <div className="events-grid">
                {events.map(event => {
                  const existingAlarm = getAlarmForEvent(event.id);
                  return (
                    <Card key={event.id} className="event-card" data-testid="event-card">
                      <CardHeader>
                        <CardTitle className="event-title">{event.title}</CardTitle>
                        <CardDescription className="event-time">
                          <Clock size={16} className="inline mr-1" />
                          {formatDateTime(event.start)}
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        {existingAlarm ? (
                          <div className="alarm-active" data-testid="alarm-active">
                            <div className="alarm-info">
                              <Bell size={20} className="alarm-icon-active" />
                              <span className="alarm-text">
                                Alarm set for {existingAlarm.alarm_minutes_before} minutes before
                              </span>
                            </div>
                            <Button
                              data-testid="delete-alarm-btn"
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDeleteAlarm(existingAlarm.id)}
                              className="delete-btn"
                            >
                              <Trash2 size={16} />
                            </Button>
                          </div>
                        ) : (
                          <div className="alarm-setup" data-testid="alarm-setup">
                            <Label htmlFor={`alarm-${event.id}`} className="alarm-label">
                              Set alarm (minutes before)
                            </Label>
                            <div className="alarm-input-group">
                              <Input
                                id={`alarm-${event.id}`}
                                data-testid="alarm-input"
                                type="number"
                                min="1"
                                placeholder="e.g., 15"
                                value={alarmSettings[event.id] || ''}
                                onChange={(e) => setAlarmSettings({
                                  ...alarmSettings,
                                  [event.id]: e.target.value
                                })}
                                className="alarm-input"
                              />
                              <Button
                                data-testid="set-alarm-btn"
                                onClick={() => handleSetAlarm(event)}
                                size="sm"
                                className="set-alarm-btn"
                              >
                                <Bell size={16} className="mr-1" />
                                Set Alarm
                              </Button>
                            </div>
                          </div>
                        )}

                        {event.location && (
                          <p className="event-location">{event.location}</p>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </>
        )}
      </main>

      {/* Audio element for alarm sound */}
      <audio
        ref={audioRef}
        src="https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3"
        loop
      />
    </div>
  );
}

export default App;