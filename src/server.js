import 'dotenv/config';
import express from 'express';
import { fetchSchedule, nowISOWeek } from './index.js';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
app.use(express.json());

// Simple cache to avoid hitting the remote on every request within same minute
let cached = { key: null, html: null, ts: 0 };

function parseLessonsFromHtml(html, targetDate = new Date()) {
  // Parse the Shkolo schedule HTML structure for a specific day
  // Returns array of { start, end, subject, teacher, room }
  const lessons = [];
  
  // Get day of week in Bulgarian (0 = Неделя, 1 = Понеделник, etc)
  const bgDays = ['Неделя', 'Понеделник', 'Вторник', 'Сряда', 'Четвъртък', 'Петък', 'Събота'];
  const targetDay = bgDays[targetDate.getDay()];
  
  // Find the column for today first
  // console.log('[DEBUG] Looking for day:', targetDay);
  
  let scheduleHtml;
  
  // First find the header for today's column
  const headerPattern = new RegExp(`<span[^>]*class="hidden-xs"[^>]*>${targetDay}<\\/span>`);
  const headerMatch = html.match(headerPattern);
  
  if (!headerMatch) {
    // console.log('[DEBUG] No column found for day:', targetDay);
    return lessons;
  }
  
  // Find the start of the column containing this day
  const beforeHeader = html.slice(0, headerMatch.index);
  const columnStart = beforeHeader.lastIndexOf('<div class="scheduleTableColumn');
  
  if (columnStart === -1) {
    // console.log('[DEBUG] Could not find start of column');
    return lessons;
  }
  
  // Find the end of this column (start of next column or end of schedule)
  const afterHeader = html.slice(headerMatch.index + headerMatch[0].length);
  const nextColumnStart = afterHeader.indexOf('<div class="scheduleTableColumn');
  const columnEnd = nextColumnStart === -1 ? html.length : headerMatch.index + headerMatch[0].length + nextColumnStart;
  
  // console.log('[DEBUG] Found column for day:', targetDay);
  // console.log('[DEBUG] Column boundaries:', {
  //  start: columnStart,
  //  end: columnEnd,
  //  length: columnEnd - columnStart
  // });
  
  // Extract just this day's column
  scheduleHtml = html.slice(columnStart, columnEnd);
  
  // Verify we got the column content
  // console.log('[DEBUG] Column preview:', scheduleHtml.substring(0, 100));
  
  // Find all lesson cells that have content for today
  // console.log('[DEBUG] First match:', scheduleHtml.match(/<div class="scheduleTableCell taken-shi"/));
  
  // Find all cells with schedule-hour attribute and course content
  const cells = [];
  let cellMatch;
  const cellRegex = /<div[^>]*?class="[^"]*?scheduleTableCell[^"]*?"[^>]*?schedule-hour=\d+[^>]*?>([\s\S]*?<div[^>]*class="scheduleTableCourse"[\s\S]*?<a class="scheduleCourse"[\s\S]*?)(?=<div[^>]*?class="[^"]*?scheduleTableCell|$)/g;
  
  // console.log('[DEBUG] Looking for cells in HTML length:', scheduleHtml.length);
  
  while ((cellMatch = cellRegex.exec(scheduleHtml)) !== null) {
    // Find the complete cell by matching nested divs
    let content = cellMatch[0];
    let openDivs = (content.match(/<div/g) || []).length;
    let closeDivs = (content.match(/<\/div>/g) || []).length;
    
    // If we're missing closing divs, add more content until we have matching pairs
    while (openDivs > closeDivs && cellRegex.lastIndex < scheduleHtml.length) {
      const nextDiv = scheduleHtml.indexOf('</div>', cellRegex.lastIndex);
      if (nextDiv === -1) break;
      
      const additionalContent = scheduleHtml.substring(cellRegex.lastIndex, nextDiv + 6);
      content += additionalContent;
      cellRegex.lastIndex = nextDiv + 6;
      
      openDivs = (content.match(/<div/g) || []).length;
      closeDivs = (content.match(/<\/div>/g) || []).length;
    }
    
    cells.push(content);
  }
  
  // console.log('[DEBUG] Found raw cells:', cells.length);
  
  // console.log('[DEBUG] Found raw cells:', cells.length);
  
  // Regex patterns for extracting lesson info
  const timeRegex = /<i class="far fa-clock"><\/i>\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/;
  const subjectRegex = /<span class="hourNum">\d+\.<\/span>\s*<i[^>]*><\/i>\s*([^<]+?)(?:\s*\/?\s*(?:Група\s+\d+|\([^)]*\)))?\s*<\/a>/;
  const teacherRegex = /<i class="icon-eyeglasses"><\/i>\s*([^<]+?)(?:\s*<|$)/;
  const roomRegex = /<i class="far fa-key"><\/i>\s*([^<(]+?)(?:\s*\([^)]*\))?(?:\s*<|$)/;
  const freeLessonRegex = /\(Свободен час\)/;
  
  // Debug the HTML content
  // console.log('[DEBUG] HTML Content:', scheduleHtml.substring(0, 500)); // Show first 500 chars
  
  // console.log('[DEBUG] Searching in HTML length:', scheduleHtml.length); // Debug log

  // Process each cell
  for (const cell of cells) {
    const timeMatch = cell.match(timeRegex);
    const subjectMatch = cell.match(subjectRegex);
    const teacherMatch = cell.match(teacherRegex);
    const roomMatch = cell.match(roomRegex);
    const isFreeLesson = freeLessonRegex.test(cell);

    if (!timeMatch || !timeMatch[1] || !timeMatch[2]) {
      // console.log('[DEBUG] Invalid time match for cell');
      continue;
    }

    const start = timeMatch[1].trim();
    const end = timeMatch[2].trim();

    // console.log('[DEBUG] Found lesson:', {
    //   time: `${start}-${end}`,
    //   subject: subjectMatch ? subjectMatch[1] : null,
    //   teacher: teacherMatch ? teacherMatch[1] : null,
    //   room: roomMatch ? roomMatch[1] : null,
    //   isFreeLesson: isFreeLesson
    // });

    lessons.push({
      start,
      end,
      subject: subjectMatch ? cleanup(subjectMatch[1]) : null,
      teacher: teacherMatch ? cleanup(teacherMatch[1]) : null,
      room: roomMatch ? cleanup(roomMatch[1]) : null,
      isFreeLesson: isFreeLesson
    });
  }
  // Merge adjacent lesson blocks that actually belong to the same lesson
  // (some schedules split a lesson into two consecutive cells). We merge
  // when subject and teacher match and the gap between blocks is very small.
  const MERGE_GAP_MINUTES = 5; // only allow very small breaks (passing time)
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
    
    // Only merge if subject, teacher AND room match, and gap is very small (<=5 min)
    // This prevents merging unrelated lessons when there are gaps in schedule
    // Also, don't merge free lessons as they should stay separate
    if (sameSubject && sameTeacher && sameRoom && gap >= 0 && gap <= MERGE_GAP_MINUTES && !last.isFreeLesson && !l.isFreeLesson) {
      // extend the end time
      last.end = l.end;
      last.endM = l.endM;
      // console.log('[DEBUG] Merged lesson blocks:', { 
      //   subject: last.subject, 
      //   teacher: last.teacher,
      //   room: last.room,
      //   gap: gap,
      //   newEnd: last.end 
      // });
    } else {
      merged.push({ ...l });
      if (sameSubject && sameTeacher) {
        // console.log('[DEBUG] NOT merging lessons:', { 
        //   subject: last.subject, 
        //   gap: gap,
        //   sameRoom: sameRoom,
        //   reason: gap > MERGE_GAP_MINUTES ? 'gap too large' : 'different room or negative gap'
        // });
      }
    }
  }

  // console.log('[DEBUG] Lessons before merge:', lessons.length, 'after merge:', merged.length);
  // Strip minute fields before returning
  return merged.map(({ start, end, subject, teacher, room, isFreeLesson }) => ({ start, end, subject, teacher, room, isFreeLesson }));
}

function cleanup(str) {
  // Remove HTML tags, convert &nbsp; to spaces, normalize whitespace
  return str
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function timeToMinutes(t) {
  const [h,m] = t.split(':').map(Number);
  return h*60 + m;
}

function findNextLesson(lessons, now = new Date()) {
  const currentMinutes = now.getHours()*60 + now.getMinutes();
  // console.log('[DEBUG] Current time in minutes:', currentMinutes);
  
  // Add minutes from start of day to each lesson
  const lessonsWithMinutes = lessons.map(l => ({ 
    ...l, 
    startM: timeToMinutes(l.start), 
    endM: timeToMinutes(l.end) 
  }));
  
  // console.log('[DEBUG] Lessons with minutes:', lessonsWithMinutes.map(l => ({
  //   subject: l.subject,
  //   startM: l.startM,
  //   endM: l.endM
  // })));
  
  // First check if we're currently in a lesson
  const currentLesson = lessonsWithMinutes.find(l => 
    l.startM <= currentMinutes && l.endM > currentMinutes
  );
  
  if (currentLesson) {
    // console.log('[DEBUG] Currently in lesson:', currentLesson.subject);
    // Instead of returning current lesson, find the next one
    const nextLesson = lessonsWithMinutes
      .filter(l => l.startM > currentMinutes)
      .sort((a,b) => a.startM - b.startM)[0];
    
    return nextLesson || null;
  }
  
  // If not in a lesson, find next one
  const nextLesson = lessonsWithMinutes
    .filter(l => l.startM > currentMinutes)
    .sort((a,b) => a.startM - b.startM)[0];
    
  return nextLesson || null;
}

async function getScheduleHtml(params) {
  const { pupilId, classYearId, week, year, forceLogin = false } = params;
  const key = `${pupilId}:${classYearId}:${week}:${year}`;
  const now = Date.now();
  if (!forceLogin && cached.key === key && (now - cached.ts) < 60_000) {
    return cached.html;
  }
  const html = await fetchSchedule({ pupilId, classYearId, week, year, outFile: 'last_schedule.html', forceLogin });
  cached = { key, html, ts: now };
  return html;
}

app.get('/sledvashtChas', async (req, res) => {
  try {
    const pupilId = req.query.pupil || process.env.PUPIL_ID;
    const classYearId = req.query.classYear || process.env.CLASS_YEAR_ID;
    const week = Number(req.query.week) || nowISOWeek();
    const year = Number(req.query.year) || (new Date().getFullYear() % 100);
    const force = req.query.forceLogin === '1' || req.query.forceLogin === 'true';
    
    // Custom time parameters
    const dayOffset = Number(req.query.dayoffset) || 0;
    const customHour = req.query.customhour ? Number(req.query.customhour) : null;
    const customMinute = req.query.customminute ? Number(req.query.customminute) : null;
    const hourOffset = req.query.houroffset ? Number(req.query.houroffset) : 0;
    const minuteOffset = req.query.minuteoffset ? Number(req.query.minuteoffset) : 0;
    
    if (!pupilId || !classYearId) {
      return res.status(400).json({ error: 'Missing pupil or classYear param (or env vars)' });
    }
    
    const html = await getScheduleHtml({ pupilId, classYearId, week, year, forceLogin: force });
    let date = new Date();
    date.setDate(date.getDate() + dayOffset);
    
    // Calculate the time to use for finding next lesson
    let checkTime = new Date();
    
    if (customHour !== null && customMinute !== null) {
      // Use custom time (same day as date)
      checkTime = new Date(date);
      checkTime.setHours(customHour, customMinute, 0, 0);
    } else {
      // Use current time with offsets
      checkTime.setHours(checkTime.getHours() + hourOffset);
      checkTime.setMinutes(checkTime.getMinutes() + minuteOffset);
    }
    
    const lessons = parseLessonsFromHtml(html, date);
    const next = findNextLesson(lessons, checkTime);
    res.json({ 
      now: new Date().toLocaleString("bg-BG"), 
      checkTime: checkTime.toLocaleString("bg-BG"),
      nextLesson: next, 
      totalLessons: lessons.length, 
      forceLoginUsed: force 
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/rawSchedule', async (req, res) => {
  try {
    const pupilId = req.query.pupil || process.env.PUPIL_ID;
    const classYearId = req.query.classYear || process.env.CLASS_YEAR_ID;
    const week = Number(req.query.week) || nowISOWeek();
    const year = Number(req.query.year) || (new Date().getFullYear() % 100);
    const force = req.query.forceLogin === '1' || req.query.forceLogin === 'true';
    if (!pupilId || !classYearId) {
      return res.status(400).send('Missing pupil or classYear');
    }
    const html = await getScheduleHtml({ pupilId, classYearId, week, year, forceLogin: force });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

const PORT = Number(process.env.PORT || process.env.SHKOLO_PORT || 3000);
function start(port, attempt=1) {
  const server = app.listen(port, () => {
    console.log(`[API] Listening on port ${port}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[API] Port ${port} in use`);
      if (attempt === 1 && !process.env.PORT && !process.env.SHKOLO_PORT) {
        const alt = port + 1;
        console.log(`[API] Retrying on ${alt} (set PORT or SHKOLO_PORT to override)`);
        start(alt, attempt+1);
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
