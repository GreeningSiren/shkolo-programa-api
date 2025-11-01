import 'dotenv/config';
import fetch from 'node-fetch';
import { writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';

const API_BASE = 'https://api.shkolo.bg/v1';
const CONFIG_FILE = 'shkolo-config.json';

// In-memory cache for session
let sessionCache = {
  api_token: null,
  user_info: null,
  pupil_id: null,
  class_year_id: null
};

/**
 * Load configuration from file
 */
async function loadConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) {
      return null;
    }
    const data = await readFile(CONFIG_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.warn('[CONFIG] Failed to load config:', error.message);
    return null;
  }
}

/**
 * Save configuration to file
 */
async function saveConfig(config) {
  try {
    await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    console.log('[CONFIG] Configuration saved');
  } catch (error) {
    console.error('[CONFIG] Failed to save config:', error.message);
  }
}

/**
 * Login to Shkolo API
 */
async function login(email, password) {
  console.log('[API] Logging in to Shkolo API...');
  
  const response = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Language': 'bg',
      'User-Agent': 'Shkolo-app-Android/1.42.8'
    },
    body: new URLSearchParams({
      email: email,
      password: password
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Login failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  
  if (!data.api_token) {
    throw new Error('No API token received from login');
  }

  // Cache session data
  sessionCache.api_token = data.api_token;
  sessionCache.user_info = data.users[0];

  console.log('[API] Login successful');
  return data;
}

/**
 * Get pupils information
 */
async function getPupils(token) {
  const response = await fetch(`${API_BASE}/diary/pupils`, {
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Language': 'bg',
      'User-Agent': 'Shkolo-app-Android/1.42.8'
    }
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('UNAUTHORIZED');
    }
    const errorText = await response.text();
    throw new Error(`Failed to get pupils: ${response.status} ${errorText}`);
  }

  return await response.json();
}

/**
 * Get schedule for a specific pupil and date
 */
async function getSchedule(token, pupilId, date) {
  const response = await fetch(`${API_BASE}/diary/pupils/${pupilId}/scheduleHours?date=${date}`, {
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Language': 'bg',
      'User-Agent': 'Shkolo-app-Android/1.42.8'
    }
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('UNAUTHORIZED');
    }
    const errorText = await response.text();
    throw new Error(`Failed to get schedule: ${response.status} ${errorText}`);
  }

  return await response.json();
}

/**
 * Ensure we have a valid token
 */
async function ensureValidToken(forceRefresh = false) {
  // If we have a cached token and not forcing refresh, use it
  if (!forceRefresh && sessionCache.api_token) {
    return sessionCache.api_token;
  }

  // Try to load config
  const config = await loadConfig();
  
  if (!config || !config.email || !config.password) {
    throw new Error('SETUP_REQUIRED');
  }

  // Login with stored credentials
  const loginData = await login(config.email, config.password);
  
  return loginData.api_token;
}

/**
 * Setup initial configuration
 */
async function setupConfig(email, password) {
  console.log('[SETUP] Setting up configuration...');
  
  // Test login
  const loginData = await login(email, password);
  
  // Get pupils data
  const pupilsData = await getPupils(loginData.api_token);
  
  // Get first pupil
  const pupils = Object.values(pupilsData.childPupils);
  if (pupils.length === 0) {
    throw new Error('No pupils found for this account');
  }
  
  const firstPupil = pupils[0];
  const config = {
    email: email,
    password: password,
    pupil_id: firstPupil.id ? firstPupil.id.toString() : firstPupil.target_id.toString(),
    class_year_id: firstPupil.class_year_id.toString(),
    pupil_name: firstPupil.target_name,
    class_name: firstPupil.class_name,
    setup_date: new Date().toISOString()
  };

  await saveConfig(config);
  
  // Update cache
  sessionCache.pupil_id = config.pupil_id;
  sessionCache.class_year_id = config.class_year_id;
  
  console.log(`[SETUP] Configuration complete for ${config.pupil_name} (${config.class_name})`);
  return config;
}

/**
 * Get config values (with fallback to env vars)
 */
async function getConfig() {
  const config = await loadConfig();
  
  return {
    pupil_id: config?.pupil_id || process.env.PUPIL_ID,
    class_year_id: config?.class_year_id || process.env.CLASS_YEAR_ID,
    email: config?.email || process.env.SHKOLO_USERNAME,
    passwordConfigured: Boolean(config?.password || process.env.SHKOLO_PASSWORD)
  };
}

/**
 * Main API wrapper with automatic token refresh
 */
async function apiRequest(endpoint, options = {}) {
  let token;
  
  try {
    token = await ensureValidToken();
  } catch (error) {
    if (error.message === 'SETUP_REQUIRED') {
      throw new Error('SETUP_REQUIRED');
    }
    throw error;
  }

  try {
    const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Language': 'bg',
        'User-Agent': 'Shkolo-app-Android/1.42.8',
        ...options.headers
      }
    });

    if (response.status === 401) {
      // Token expired, try to refresh once
      console.log('[API] Token expired, refreshing...');
      token = await ensureValidToken(true);
      
      const retryResponse = await fetch(url, {
        ...options,
        headers: {
          'Accept': 'application/json',
          'Authorization': `Bearer ${token}`,
          'Language': 'bg',
          'User-Agent': 'Shkolo-app-Android/1.42.8',
          ...options.headers
        }
      });

      if (!retryResponse.ok) {
        const errorText = await retryResponse.text();
        throw new Error(`API request failed: ${retryResponse.status} ${errorText}`);
      }

      return await retryResponse.json();
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed: ${response.status} ${errorText}`);
    }

    return await response.json();
  } catch (error) {
    throw error;
  }
}

export {
  login,
  getPupils,
  getSchedule,
  setupConfig,
  getConfig,
  apiRequest,
  ensureValidToken
};

