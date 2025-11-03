import 'dotenv/config';
import express from 'express';
import { setupConfig, getConfig, apiRequest } from './shkolo-api.js';
import readline from 'readline';

const app = express();
app.use(express.json());

// Helper function to get date in YYYY-MM-DD format
function formatDate(date) {
  return date.toISOString().split('T')[0];
}

// Helper function to convert API lesson to our format
function convertApiLesson(lesson) {
  return {
    start: lesson.from_time,
    end: lesson.to_time,
    subject: lesson.short_course_name,
    teacher: lesson.teacher_name,
    room: cleanRoomNumber(lesson.room_name),
    isFreeLesson: lesson.is_free_hour === 1
  };
}

// Helper function to clean room number - extract only the number
function cleanRoomNumber(roomName) {
  if (!roomName) return null;
  
  // Extract just the number from formats like "34 (Етаж 3)" or "80 (Спортни 8)"
  const match = roomName.match(/^(\d+)/);
  return match ? match[1] : roomName;
}

// Merge adjacent lessons with same subject/teacher/room
function mergeLessons(lessons) {
  if (lessons.length === 0) return lessons;
  
  const MERGE_GAP_MINUTES = 5;
  
  const timeToMinutes = (timeStr) => {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
  };
  
  const lessonsWithMins = lessons
    .map(l => ({ ...l, startM: timeToMinutes(l.start), endM: timeToMinutes(l.end) }))
    .sort((a, b) => a.startM - b.startM);

  const merged = [];
  for (const l of lessonsWithMins) {
    if (merged.length === 0) {
      merged.push({ ...l });
      continue;
    }
    
    const last = merged[merged.length - 1];
    const sameSubject = last.subject && l.subject && last.subject === l.subject;
    const sameTeacher = last.teacher && l.teacher && last.teacher === l.teacher;
    const sameRoom = last.room && l.room && last.room === l.room;
    const gap = l.startM - last.endM;
    
    // Only merge if subject, teacher AND room match, gap is small
    if (sameSubject && sameTeacher && sameRoom && gap >= 0 && gap <= MERGE_GAP_MINUTES) {
      last.end = l.end;
      last.endM = l.endM;
      if (process.env.DEBUG) {
        console.log('[DEBUG] Merged lesson blocks:', { 
          subject: last.subject, 
          teacher: last.teacher,
          room: last.room,
          gap: gap,
          newEnd: last.end 
        });
      }
    } else {
      merged.push({ ...l });
    }
  }

  // Strip minute fields before returning
  return merged.map(({ start, end, subject, teacher, room, isFreeLesson }) => ({ start, end, subject, teacher, room, isFreeLesson }));
}

// Find next lesson
function findNextLesson(lessons, now = new Date()) {
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  
  const timeToMinutes = (timeStr) => {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
  };
  
  const lessonsWithMinutes = lessons.map(l => ({ 
    ...l, 
    startM: timeToMinutes(l.start), 
    endM: timeToMinutes(l.end) 
  }));
  
  // First check if we're currently in a lesson
  const currentLesson = lessonsWithMinutes.find(l => 
    l.startM <= currentMinutes && l.endM > currentMinutes
  );
  
  if (currentLesson) {
    // Find the next one after current lesson
    const nextLesson = lessonsWithMinutes
      .filter(l => l.startM > currentMinutes)
      .sort((a, b) => a.startM - b.startM)[0];
    
    return nextLesson || null;
  }
  
  // If not in a lesson, find next one
  const nextLesson = lessonsWithMinutes
    .filter(l => l.startM > currentMinutes)
    .sort((a, b) => a.startM - b.startM)[0];
    
  return nextLesson || null;
}

// Setup endpoint for first-time configuration
app.post('/setup', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const config = await setupConfig(email, password);
    res.json({ 
      message: 'Setup completed successfully',
      pupil_name: config.pupil_name,
      class_name: config.class_name,
      pupil_id: config.pupil_id,
      class_year_id: config.class_year_id
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get next lesson
app.get('/sledvashtChas', async (req, res) => {
  try {
    const config = await getConfig();
    const pupilId = req.query.pupil || config.pupil_id;
    const dayOffset = Number(req.query.dayoffset) || 0;
    
    // Custom time parameters
    const customHour = req.query.customhour ? Number(req.query.customhour) : null;
    const customMinute = req.query.customminute ? Number(req.query.customminute) : null;
    const hourOffset = req.query.houroffset ? Number(req.query.houroffset) : 0;
    const minuteOffset = req.query.minuteoffset ? Number(req.query.minuteoffset) : 0;
    
    if (!pupilId) {
      return res.status(400).json({ 
        error: 'No pupil ID configured. Use POST /setup to configure or pass pupil parameter',
        setupRequired: true
      });
    }
    
    // Calculate target date
    let targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + dayOffset);
    const dateStr = formatDate(targetDate);
    
    // Get schedule from API
    const scheduleData = await apiRequest(`/diary/pupils/${pupilId}/scheduleHours?date=${dateStr}`);
    
    // Convert and merge lessons
    const lessons = mergeLessons(scheduleData.scheduleHours.map(convertApiLesson));
    
    // Calculate check time
    let checkTime = new Date();
    if (customHour !== null && customMinute !== null) {
      checkTime = new Date(targetDate);
      checkTime.setHours(customHour, customMinute, 0, 0);
    } else {
      checkTime.setDate(targetDate.getDate());
      checkTime.setHours(checkTime.getHours() + hourOffset);
      checkTime.setMinutes(checkTime.getMinutes() + minuteOffset);
    }
    
    const next = findNextLesson(lessons, checkTime);
    
    res.json({ 
      now: new Date().toLocaleString("bg-BG"), 
      checkTime: checkTime.toLocaleString("bg-BG"),
      date: dateStr,
      nextLesson: next, 
      totalLessons: lessons.length
    });
  } catch (e) {
    if (e.message === 'SETUP_REQUIRED') {
      return res.status(400).json({ 
        error: 'Setup required. Use POST /setup to configure credentials.',
        setupRequired: true
      });
    }
    res.status(500).json({ error: e.message });
  }
});

// Get raw schedule data
app.get('/rawSchedule', async (req, res) => {
  try {
    const config = await getConfig();
    const pupilId = req.query.pupil || config.pupil_id;
    const dayOffset = Number(req.query.dayoffset) || 0;
    
    if (!pupilId) {
      return res.status(400).json({ 
        error: 'No pupil ID configured. Use POST /setup to configure or pass pupil parameter',
        setupRequired: true
      });
    }
    
    // Calculate target date
    let targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + dayOffset);
    const dateStr = formatDate(targetDate);
    
    // Get schedule from API
    const scheduleData = await apiRequest(`/diary/pupils/${pupilId}/scheduleHours?date=${dateStr}`);
    
    res.json(scheduleData);
  } catch (e) {
    if (e.message === 'SETUP_REQUIRED') {
      return res.status(400).json({ 
        error: 'Setup required. Use POST /setup to configure credentials.',
        setupRequired: true
      });
    }
    res.status(500).json({ error: e.message });
  }
});

// Get config info
app.get('/config', async (req, res) => {
  try {
    const config = await getConfig();
    res.json({
      hasConfig: !!(config.pupil_id && config.email),
      pupil_id: config.pupil_id,
      class_year_id: config.class_year_id
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = Number(process.env.PORT || process.env.SHKOLO_PORT || 3000);

async function checkSetup() {
  try {
    const config = await getConfig();
    if (!config.pupil_id || !config.email) {
      console.log('\n🔧 Setup required!');
      console.log('No configuration found. Please provide your Shkolo credentials:\n');

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

      try {
        const email = await question('Enter your Shkolo email/username: ');
        const password = await question('Enter your password: ');
        
        console.log('\n📡 Connecting to Shkolo...');
        const setupResult = await setupConfig(email, password);
        console.log(`✅ Setup complete for ${setupResult.pupil_name} (${setupResult.class_name})`);
        console.log('🚀 Server is ready! You can now use the API endpoints.\n');
      } finally {
        rl.close();
      }
    } else {
      console.log('✅ Configuration loaded successfully');
    }
  } catch (error) {
    console.log('❌ Setup failed:', error.message);
    console.log('Please check your credentials and try again.');
    process.exit(1);
  }
}

function start(port, attempt = 1) {
  const server = app.listen(port, async () => {
    console.log(`[API] Shkolo API Server listening on port ${port}`);
    console.log(`[API] Using official Shkolo API at https://api.shkolo.bg`);
    
    // Check setup only after server starts
    await checkSetup();
  });
  
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[API] Port ${port} in use`);
      if (attempt === 1 && !process.env.PORT && !process.env.SHKOLO_PORT) {
        const alt = port + 1;
        console.log(`[API] Retrying on ${alt} (set PORT or SHKOLO_PORT to override)`);
        start(alt, attempt + 1);
      } else {
        console.error('[API] Set PORT=xxxx to choose a free port.');
        process.exit(1);
      }
    } else {
      console.error('[API] Server error:', err.message);
      process.exit(1);
    }
  });
}

start(PORT);

