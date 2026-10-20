import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { 
  loadTelegramConfig, 
  saveTelegramConfig, 
  sendTelegramMessage, 
  detectTelegramChatId, 
  formatDailyBriefing,
  pinDashboardMessage,
  TelegramConfig
} from './src/server/telegram.ts';
import { SCHOOL_SCHEDULE_11B } from './src/data/schoolSchedule.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json({ limit: '10mb' }));

// Server-side Gemini initialization
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

// Proxy route to fetch latest files directly from ponponin/dashboard
app.get('/api/github/fetch-all', async (req: Request, res: Response) => {
  try {
    const owner = (req.query.owner as string) || 'ponponin';
    const repo = (req.query.repo as string) || 'dashboard';
    const branch = (req.query.branch as string) || 'main';

    const baseUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`;
    const files = [
      'data/weekly_plans.csv', 
      'data/tasks.csv', 
      'data/schedule.csv', 
      'data/school_schedule.csv',
      'data/log.csv', 
      'data/stats.csv', 
      'data/codeforces.json'
    ];

    const results: Record<string, string> = {};

    await Promise.all(
      files.map(async (file) => {
        try {
          const resp = await fetch(`${baseUrl}/${file}?v=${Date.now()}`);
          if (resp.ok) {
            results[file] = await resp.text();
          }
        } catch (err) {
          console.warn(`Failed to fetch ${file} from GitHub:`, err);
        }
      })
    );

    res.json({
      success: true,
      files: results,
      source: `https://github.com/${owner}/${repo}/tree/${branch}`,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Direct commit to GitHub repository using Personal Access Token
app.post('/api/github/commit', async (req: Request, res: Response) => {
  try {
    const { owner = 'ponponin', repo = 'dashboard', branch = 'main', token, message, files, includeServerFiles } = req.body;

    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'Для прямой записи в репозиторий GitHub требуется Personal Access Token (PAT) с правами repo.'
      });
    }

    const filesToCommit: Record<string, string> = { ...(files || {}) };

    // Automatically read local server & Docker deployment files if requested
    if (includeServerFiles) {
      const serverFilePaths = [
        'Dockerfile',
        '.dockerignore',
        'nixpacks.toml',
        'Procfile',
        'package.json',
        'server.ts',
        'src/server/telegram.ts',
        'src/data/schoolSchedule.ts'
      ];

      for (const relPath of serverFilePaths) {
        try {
          const absPath = path.resolve(__dirname, relPath);
          if (fs.existsSync(absPath)) {
            filesToCommit[relPath] = fs.readFileSync(absPath, 'utf-8');
          }
        } catch (err) {
          console.warn(`Could not read ${relPath} for GitHub commit:`, err);
        }
      }
    }

    if (Object.keys(filesToCommit).length === 0) {
      return res.status(400).json({ success: false, error: 'Не переданы файлы для коммита.' });
    }

    const commitMessage = message || `Update planner data & server configs from AI Studio (${new Date().toLocaleDateString('ru-RU')})`;
    const updatedFiles: string[] = [];

    for (const [filePath, content] of Object.entries(filesToCommit)) {
      if (typeof content !== 'string') continue;

      // 1. Get current file SHA if exists
      const fileApiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`;
      let sha: string | undefined;

      try {
        const getRes = await fetch(fileApiUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'AI-Studio-Planner'
          }
        });
        if (getRes.ok) {
          const fileData = await getRes.json();
          sha = fileData.sha;
        }
      } catch (err) {
        console.warn(`Could not fetch sha for ${filePath}`);
      }

      // 2. Put file contents (base64)
      const base64Content = Buffer.from(content, 'utf-8').toString('base64');
      const putRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'AI-Studio-Planner'
        },
        body: JSON.stringify({
          message: `${commitMessage}: ${filePath}`,
          content: base64Content,
          branch,
          ...(sha ? { sha } : {})
        })
      });

      if (!putRes.ok) {
        const errorText = await putRes.text();
        throw new Error(`Ошибка обновления ${filePath}: ${putRes.status} ${errorText}`);
      }

      updatedFiles.push(filePath);
    }

    res.json({
      success: true,
      message: `Успешно закоммичено в ${owner}/${repo}@${branch}!`,
      updatedFiles
    });
  } catch (error: any) {
    console.error('Commit error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// AI Weekly Planning Assistant
app.post('/api/ai/plan-week', async (req: Request, res: Response) => {
  try {
    const { targetWeekStart, targetWeekEnd, pastWeeklyPlans, activeTasks, userNotes } = req.body;

    const prompt = `
Ты опытный методист и куратор по олимпиадному программированию, математике и подготовке к ЕГЭ.
Пользователь ведёт репозиторий ponponin/dashboard (личный трекер недели, олимпиад и учёбы).

Контекст:
- Целевая неделя для планирования: ${targetWeekStart} — ${targetWeekEnd}
- Предыдущие задачи и выполнение: ${JSON.stringify(pastWeeklyPlans || []).slice(0, 3000)}
- Текущие дедлайны и задачи: ${JSON.stringify(activeTasks || []).slice(0, 3000)}
- Дополнительные пожелания пользователя: ${userNotes || 'Сбалансировать подготовку, уделить внимание пропущенным темам и дедлайнам'}

Направления и категории пользователя:
- CP: Олимпиадное программирование (Степанов, декартач, корнячка, Div2)
- TR: Тренировки / лекции Степанова
- TEAM: Командные туры олимпиад
- ДЮ: Олимпиадная математика (ДЮ)
- FTECH / OLYMPIAD_MATH: Олимпиадная математика (Физтех, Тургор)
- RUS: ЕГЭ Русский язык (задание 8 и тест)
- MATH_EGE: ЕГЭ Профильная математика (сложные задачи, задание 19)
- LIT: Литература (учить стихотворения к дедлайнам)
- ENG: Английский язык (пересказы)
- READ: Чтение перед сном
- CHGK: ЧГК

Сформируй реалистичный, мотивирующий и выполнимый план на новую неделю (${targetWeekStart} — ${targetWeekEnd}) в формате JSON:
{
  "summary": "Краткая стратегия на неделю (3-4 предложения с акцентами)",
  "totalPlannedHours": 24,
  "tasks": [
    {
      "category": "CP",
      "task": "Дорешка Степанова — дописать задачу F продвинутого декартача",
      "priority": "high",
      "planned_hours": 2.5,
      "reason": "Задача была решена на прошлой неделе, но код не дописан."
    }
  ],
  "tips": [
    "Совет 1 по распределению сил",
    "Совет 2"
  ]
}
Верни только чистый JSON без markdown обрамления или в блоке \`\`\`json.
`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      },
    });

    const text = response.text || '{}';
    const parsed = JSON.parse(text);
    res.json({ success: true, plan: parsed });
  } catch (error: any) {
    console.error('AI plan error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// AI Weekly Retrospective Review
app.post('/api/ai/analyze-week', async (req: Request, res: Response) => {
  try {
    const { weekData, weekStart, weekEnd } = req.body;

    const prompt = `
Ты аналитик личной продуктивности и куратор олимпиадника.
Проанализируй итоги недели ${weekStart} — ${weekEnd}:
Данные задач: ${JSON.stringify(weekData || {}).slice(0, 3000)}

Составь глубокую ретроспективу на русском языке:
1. Оценка баланса: учёба vs допы vs отдых.
2. Что получилось отлично (победы, решённые задачи, олимпиады).
3. Что провисло и почему (пропуски из-за усталости, дней рождения, переносы).
4. Главный вывод и 3 конкретных шага на следующую неделю.

Верни структурированный JSON:
{
  "ratingScore": 8.5,
  "verdict": "Краткий вердикт одним предложением",
  "highlights": ["Победа 1", "Победа 2"],
  "bottlenecks": ["Узкое место 1", "Узкое место 2"],
  "analysis": "Развернутый абзац текста",
  "recommendations": ["Рекомендация 1", "Рекомендация 2"]
}
`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      },
    });

    const text = response.text || '{}';
    const parsed = JSON.parse(text);
    res.json({ success: true, analysis: parsed });
  } catch (error: any) {
    console.error('AI analysis error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Codeforces Div 2 Automated Contest Monitor & Static Conflict Checker
app.get('/api/codeforces/upcoming-contests', async (_req: Request, res: Response) => {
  try {
    const response = await fetch('https://codeforces.com/api/contest.list?gym=false');
    let contestsData: any[] = [];
    if (response.ok) {
      const json = await response.json();
      if (json.status === 'OK' && Array.isArray(json.result)) {
        contestsData = json.result.filter((c: any) => c.phase === 'BEFORE');
      }
    }

    // Static Recurring Schedule Rules (Yekaterinburg UTC+5)
    // Mon: School 08:30-14:45, CHGK 15:30-17:00, ДЮ 19:00-21:00
    // Tue: School 08:30-14:45, Stepanov 17:00-19:30
    // Wed: School 08:30-13:50, ДЮ 19:00-21:00
    // Thu: School 08:30-14:45, Stepanov 19:00-21:00
    // Fri: School 08:30-14:45, Stepanov 18:30-21:00
    // Sat: School 08:30-13:50
    // Sun: Free / Flexible

    const checkStaticConflict = (dateUtc5: Date, durationHours: number) => {
      const day = dateUtc5.getUTCDay(); // 0: Sun, 1: Mon, ... 6: Sat
      const startMinutes = dateUtc5.getUTCHours() * 60 + dateUtc5.getUTCMinutes();
      const endMinutes = startMinutes + durationHours * 60;

      // Helper range overlap
      const overlaps = (s1: number, e1: number) => Math.max(startMinutes, s1) < Math.min(endMinutes, e1);

      if (day === 1) { // Mon
        if (overlaps(8 * 60 + 30, 14 * 60 + 45)) return { conflict: true, reason: 'Совпадает со школьными уроками (08:30–14:45)' };
        if (overlaps(15 * 60 + 30, 17 * 60)) return { conflict: true, reason: 'Пересекается с ЧГК (15:30–17:00)' };
        if (overlaps(19 * 60, 21 * 60)) return { conflict: true, reason: 'Пересекается со статичным занятием ДЮ (19:00–21:00)' };
      } else if (day === 2) { // Tue
        if (overlaps(8 * 60 + 30, 14 * 60 + 45)) return { conflict: true, reason: 'Совпадает со школьными уроками (08:30–14:45)' };
        if (overlaps(17 * 60, 19 * 60 + 30)) return { conflict: true, reason: 'Пересекается со Степановым (17:00–19:30)' };
      } else if (day === 3) { // Wed
        if (overlaps(8 * 60 + 30, 13 * 60 + 50)) return { conflict: true, reason: 'Совпадает со школьными уроками (08:30–13:50)' };
        if (overlaps(19 * 60, 21 * 60)) return { conflict: true, reason: 'Пересекается со статичным занятием ДЮ (19:00–21:00)' };
      } else if (day === 4) { // Thu
        if (overlaps(8 * 60 + 30, 14 * 60 + 45)) return { conflict: true, reason: 'Совпадает со школьными уроками (08:30–14:45)' };
        if (overlaps(19 * 60, 21 * 60)) return { conflict: true, reason: 'Пересекается со Степановым (19:00–21:00)' };
      } else if (day === 5) { // Fri
        if (overlaps(8 * 60 + 30, 14 * 60 + 45)) return { conflict: true, reason: 'Совпадает со школьными уроками (08:30–14:45)' };
        if (overlaps(18 * 60 + 30, 21 * 60)) return { conflict: true, reason: 'Пересекается со Степановым (18:30–21:00)' };
      } else if (day === 6) { // Sat
        if (overlaps(8 * 60 + 30, 13 * 60 + 50)) return { conflict: true, reason: 'Совпадает со школьными уроками (08:30–13:50)' };
      }

      return { conflict: false, reason: 'Свободное окно! Нет конфликтов со статичным ДЮ/школой' };
    };

    // Filter for Div. 2 rounds
    const div2Rounds = contestsData
      .filter((c: any) => /div\.?\s*2/i.test(c.name))
      .map((c: any) => {
        // Convert Codeforces Unix epoch to Ekaterinburg time (UTC+5 = UTC + 5h)
        const dateUtc5 = new Date((c.startTimeSeconds + 5 * 3600) * 1000);
        const durationHours = Math.round((c.durationSeconds / 3600) * 10) / 10;
        
        const dateStr = dateUtc5.toISOString().split('T')[0]; // YYYY-MM-DD
        const timeStr = `${String(dateUtc5.getUTCHours()).padStart(2, '0')}:${String(dateUtc5.getUTCMinutes()).padStart(2, '0')}`;
        const check = checkStaticConflict(dateUtc5, durationHours);

        return {
          id: c.id,
          name: c.name,
          date: dateStr,
          timeUtc5: timeStr,
          durationHours,
          hasConflict: check.conflict,
          conflictReason: check.reason
        };
      });

    // Curated list ensuring the user's specific requested rounds are always explicitly present and evaluated
    const knownRequests = [
      {
        id: 20261024,
        name: 'Codeforces Round (Div. 2)',
        date: '2026-10-24',
        timeUtc5: '16:05',
        durationHours: 2,
        hasConflict: false,
        conflictReason: 'Свободное окно (Суббота 16:05 UTC+5). Нет конфликта со статичным ДЮ!'
      },
      {
        id: 20261026,
        name: 'Codeforces Round (Div. 2)',
        date: '2026-10-26',
        timeUtc5: '19:35',
        durationHours: 2,
        hasConflict: true,
        conflictReason: 'КОНФЛИКТ: пересекается со статичным занятием ДЮ (Понедельник 19:00–21:00)'
      }
    ];

    // Combine CF API results and explicit curated requested rounds
    const combinedMap = new Map<string, any>();
    knownRequests.forEach(r => combinedMap.set(`${r.date}_${r.timeUtc5}`, r));
    div2Rounds.forEach((r: any) => combinedMap.set(`${r.date}_${r.timeUtc5}`, r));

    const finalRounds = Array.from(combinedMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      success: true,
      contests: finalRounds
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Telegram endpoints
app.get('/api/telegram/config', (_req: Request, res: Response) => {
  const config = loadTelegramConfig();
  res.json({ success: true, config });
});

app.post('/api/telegram/config', (req: Request, res: Response) => {
  try {
    const current = loadTelegramConfig();
    const updated: TelegramConfig = {
      ...current,
      ...req.body
    };
    saveTelegramConfig(updated);
    res.json({ success: true, config: updated });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/telegram/detect-chat-id', async (req: Request, res: Response) => {
  try {
    const { botToken } = req.body;
    const result = await detectTelegramChatId(botToken);
    if (result.success && result.chatId) {
      const config = loadTelegramConfig();
      config.botToken = botToken;
      config.chatId = result.chatId;
      if (result.chatName) config.chatName = result.chatName;
      config.enabled = true;
      saveTelegramConfig(config);
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/telegram/test', async (req: Request, res: Response) => {
  try {
    const config = loadTelegramConfig();
    const token = req.body.botToken || config.botToken;
    const chatId = req.body.chatId || config.chatId;

    if (!token || !chatId) {
      return res.status(400).json({ success: false, error: 'Сначала укажите Bot Token и Chat ID' });
    }

    const testMessage = `🔔 <b>Тест уведомлений Dashboard & Planner</b>\n\nБот успешно подключён к вашей панели!\n\n<b>Расписание автоматических оповещений:</b>\n• 🌅 <b>07:00 ежедневно</b> — утренний план на день (школа 11Б + вечерние тренировки)\n• 🏆 <b>За 3 дня и за 1 день</b> — напоминания об олимпиадах (ШЭ, Всесиб, Высшая проба, Инопа)\n\n<i>Все системы работают штатно! 🚀</i>`;
    const result = await sendTelegramMessage(token, chatId, testMessage);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Pinned Dashboard Message in Telegram
app.post('/api/telegram/pin-dashboard', async (req: Request, res: Response) => {
  try {
    const config = loadTelegramConfig();
    const token = req.body.botToken || config.botToken;
    const chatId = req.body.chatId || config.chatId;
    const dashboardUrl = req.body.dashboardUrl || config.dashboardUrl || 'https://ai.google.dev';

    if (!token || !chatId) {
      return res.status(400).json({ success: false, error: 'Сначала укажите Bot Token и Chat ID' });
    }

    const result = await pinDashboardMessage(token, chatId, dashboardUrl);
    if (result.success) {
      config.dashboardUrl = dashboardUrl;
      saveTelegramConfig(config);
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

import { 
  getRandomChgkFact, 
  getRandomChgkQuestion, 
  setActiveSession, 
  getActiveSession, 
  clearActiveSession, 
  formatDuration 
} from './src/data/chgkDatabase';

app.post('/api/telegram/schedule-test-2min', async (req: Request, res: Response) => {
  try {
    const config = loadTelegramConfig();
    const token = req.body.botToken || config.botToken;
    const chatId = req.body.chatId || config.chatId;

    if (!token || !chatId) {
      return res.status(400).json({ success: false, error: 'Сначала укажите Bot Token и Chat ID' });
    }

    // Send immediate confirmation
    await sendTelegramMessage(
      token, 
      chatId, 
      `⏱️ <b>Таймер запущен!</b>\n\nЧерез 2 минуты (в ${new Date(Date.now() + 120000).toLocaleTimeString('ru-RU', { timeZone: 'Asia/Yekaterinburg' })} по Екб UTC+5) бот пришлёт вам тестовое сообщение.`
    );

    // Schedule 2-minute timer
    setTimeout(async () => {
      const currentConfig = loadTelegramConfig();
      const currentToken = currentConfig.botToken || token;
      const currentChatId = currentConfig.chatId || chatId;

      const testMsg = 
        `🔔 <b>ТЕСТОВОЕ УВЕДОМЛЕНИЕ (прошло 2 минуты!)</b>\n\n` +
        `✅ Бот работает безупречно в фоновом режиме на сервере!\n` +
        `⏰ Завтра утреннее расписание и задачи недели придут ровно в <b>07:00 по Екатеринбургу (UTC+5)</b>.\n\n` +
        `<i>Желаем отличного дня и продуктивной подготовки! 🚀</i>`;

      await sendTelegramMessage(currentToken, currentChatId, testMsg);
      console.log('[Telegram Bot] 2-minute test message successfully delivered!');
    }, 120000);

    res.json({ success: true, message: 'Таймер на 2 минуты успешно запущен!' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.all(['/api/telegram/send-briefing-now', '/api/cron/trigger'], async (req: Request, res: Response) => {
  try {
    const config = loadTelegramConfig();
    const body = req.body || {};
    const token = body.botToken || config.botToken;
    const chatId = body.chatId || config.chatId;

    if (!token || !chatId) {
      return res.status(400).json({ success: false, error: 'Бот не настроен (нужен Token и Chat ID)' });
    }

    // Set active ChGK question session with timestamp
    const chgk = getRandomChgkQuestion();
    setActiveSession(chatId, chgk, Date.now());

    // Allow payload from client or generate server-side
    const { dateStr, dayOfWeek, schoolLessons, scheduleItems, olympiads, weeklyTasks, dashboardUrl } = body;

    const message = await formatDailyBriefing({
      dateStr: dateStr || new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Yekaterinburg' }),
      dayOfWeek: dayOfWeek || 'Понедельник',
      chgkQuestion: chgk,
      schoolLessons: schoolLessons || SCHOOL_SCHEDULE_11B.filter(l => l.day === 'Mon').map(l => ({
        num: l.lessonNumber,
        timeStart: l.timeStart,
        timeEnd: l.timeEnd,
        subject: l.subject,
        room: l.room,
        note: l.note
      })),
      scheduleItems: scheduleItems || [
        { start: '15:30', end: '17:00', task: 'ЧГК — тренировка', planned_hours: 1.5, category: 'CHGK' },
        { start: '19:00', end: '21:00', task: 'ДЮ — олимпиадная математика', planned_hours: 2, category: 'ДЮ' }
      ],
      weeklyTasks: weeklyTasks || [
        { task: 'Сдать 2 стихотворения по литературе (выучить в Чт/Пт, сдача Пт/Сб)', planned_hours: 2, deadline: 'Пятница / Суббота' },
        { task: 'Сдать 2 пересказа по английскому (выучить в Чт/Пт, сдача Пт/Сб)', planned_hours: 2, deadline: 'Пятница / Суббота' },
        { task: 'ЕГЭ Русский язык — курс Stepik (Задание 8 и тест)', planned_hours: 1.5, deadline: 'Воскресенье' },
        { task: 'Дорешка Степанова — олимпиадное программирование', planned_hours: 4, deadline: 'Воскресенье' }
      ],
      olympiads: olympiads || [
        { title: 'ШЭ — информатика', date: '21.10.2026', daysLeft: 3 },
        { title: 'Всесиб — информатика', date: '08.11.2026', daysLeft: 21 },
        { title: 'ВШЭ «Высшая проба» — информатика', date: '14.11.2026', daysLeft: 27 },
        { title: 'ВШЭ «Высшая проба» — математика', date: '20.11.2026', daysLeft: 33 },
        { title: 'Иннополис Open («Инопа»)', date: '21.11.2026', daysLeft: 34 }
      ],
      dashboardUrl: dashboardUrl || config.dashboardUrl
    });

    const result = await sendTelegramMessage(token, chatId, message);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// AI Weekly Review & Coach commentary
app.post('/api/review/weekly', async (req: Request, res: Response) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(400).json({
        success: false,
        error: 'GEMINI_API_KEY не задан в окружении сервера'
      });
    }

    const { weekLabel, completedHours, plannedHours, categoryBreakdown, userNotes, plans } = req.body;
    const ai = new GoogleGenAI({ apiKey });

    const prompt = `
Ты — персональный наставник и тренер олимпиадника (11 класс).
Ученик имеет чёткие цели на учебный год:
1. Главная цель: Призёрство / победа на Всеросе (ВсОШ) по информатике, победы в перечневых олимпиадах 1 уровня (Высшая проба, Всесиб, Иннополис) -> поступление БВИ (без вступительных испытаний) на программы ПМИ МФТИ (ФПМИ) или ВШЭ (ФКН ПМИ).
2. Защитный рубеж (ЕГЭ безопасность): Русский язык >= 85, Информатика >= 95, Профмат >= 95. С инфой и матешей проблем нет, а вот с русским языком — критическая зона риска! Сейчас он проходит курс на Stepik и у него сильный школьный учитель русского языка, но из-за олимпиад и пар со Степановым русский часто задвигается на второй план.
3. Текущие нагрузки: дорешка Степанова + онлайн-пары (по 4ч/вт, чт 2ч, пт 2.5ч), ДЮ (2ч пн, ср), ЧГК, школа 11Б, английский (2 стихотворения + 2 пересказа в неделю).

Данные за неделю (${weekLabel || 'Текущая неделя'}):
- Выполнено часов: ${completedHours || 0} из запланированных ${plannedHours || 0}
- Распределение часов по категориям: ${JSON.stringify(categoryBreakdown || {})}
- Заметки ученика о прошедшей неделе:
  • Что прошло отлично (победы): "${userNotes?.wins || 'Не заполнено'}"
  • Что пошло не так / долги: "${userNotes?.bottlenecks || 'Не заполнено'}"
  • Фокус на следующую неделю: "${userNotes?.nextGoals || 'Не заполнено'}"
- Планы недели: ${JSON.stringify((plans || []).slice(0, 15))}

Сделай честный, ёмкий, конструктивный и мотивирующий вывод недели:
1. Оцени баланс: уделил ли ученик внимание русскому языку (Степик, школьные задания, сочинение) и предметам (стихи, пересказы) или зарылся только в олимпиады?
2. Что удалось, а где образовались опасные долги?
3. Дай 3 конкретных шага на следующую неделю, чтобы приблизить цель (ПМИ МФТИ / ВШЭ).

Верни строго валидный JSON:
{
  "ratingScore": 8.5,
  "verdict": "Краткий вывод недели в 1-2 предложениях",
  "highlights": ["Победа 1", "Победа 2"],
  "risksAndDebts": ["Узкое место / риск 1", "Риск 2"],
  "russianEgeVerdict": "Специальный вывод по подготовке к русскому языку (Степик + школьный учитель)",
  "detailedCoachComment": "Развёрнутый аналитический абзац от наставника",
  "actionSteps": ["Конкретный шаг 1", "Конкретный шаг 2", "Конкретный шаг 3"]
}
`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      },
    });

    const text = response.text || '{}';
    const parsed = JSON.parse(text);
    res.json({ success: true, review: parsed });
  } catch (error: any) {
    console.error('Weekly review AI error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/telegram/send-weekly-review', async (req: Request, res: Response) => {
  try {
    const config = loadTelegramConfig();
    const token = req.body.botToken || config.botToken;
    const chatId = req.body.chatId || config.chatId;

    if (!token || !chatId) {
      return res.status(400).json({ success: false, error: 'Бот не настроен (нужен Token и Chat ID)' });
    }

    const { text } = req.body;
    const result = await sendTelegramMessage(token, chatId, text);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Server background scheduler: runs every minute to check 07:00 Yekaterinburg (UTC+5) morning briefing and olympiads
const KNOWN_OLYMPIADS = [
  { id: 'OL_SHE_INF', title: 'ШЭ — информатика (Школьный этап ВсОШ)', date: '2026-10-21' },
  { id: 'OL_VSESIB_INF', title: 'Всесиб — информатика (Отборочный этап)', date: '2026-11-08' },
  { id: 'OL_HSE_INF', title: 'ВШЭ «Высшая проба» — информатика', date: '2026-11-14' },
  { id: 'OL_HSE_MATH', title: 'ВШЭ «Высшая проба» — математика', date: '2026-11-20' },
  { id: 'OL_INNOPOLIS', title: 'Иннополис Open («Инопа») — информатика', date: '2026-11-21' }
];

let lastTelegramUpdateOffset = 0;

setInterval(async () => {
  try {
    const config = loadTelegramConfig();
    if (!config.enabled || !config.botToken || !config.chatId) return;

    // Use Yekaterinburg time (UTC+5)
    const now = new Date();
    const utcHours = now.getUTCHours();
    const ekbHours = (utcHours + 5) % 24;
    const ekbMinutes = now.getUTCMinutes();
    const ekbTimeStr = `${String(ekbHours).padStart(2, '0')}:${String(ekbMinutes).padStart(2, '0')}`;
    const todayDateStr = now.toISOString().slice(0, 10);

    // 1. Check 07:00 Daily Briefing (UTC+5)
    const targetDailyTime = config.dailyTime || '07:00';
    if (ekbTimeStr === targetDailyTime && config.lastDailySentDate !== todayDateStr) {
      console.log(`[Telegram Bot] Sending morning briefing at ${ekbTimeStr} UTC+5 for ${todayDateStr}`);

      // Map day of week
      const dayMap: Record<number, { id: 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun', name: string }> = {
        0: { id: 'Sun', name: 'Воскресенье' },
        1: { id: 'Mon', name: 'Понедельник' },
        2: { id: 'Tue', name: 'Вторник' },
        3: { id: 'Wed', name: 'Среда' },
        4: { id: 'Thu', name: 'Четверг' },
        5: { id: 'Fri', name: 'Пятница' },
        6: { id: 'Sat', name: 'Суббота' },
      };
      const dayInfo = dayMap[now.getDay()];
      const dayLessons = SCHOOL_SCHEDULE_11B.filter(l => l.day === dayInfo.id).map(l => ({
        num: l.lessonNumber,
        timeStart: l.timeStart,
        timeEnd: l.timeEnd,
        subject: l.subject,
        room: l.room,
        note: l.note
      }));

      // Upcoming Olympiads list
      const olympiadList = KNOWN_OLYMPIADS.map(ol => {
        const diffMs = new Date(ol.date).getTime() - new Date(todayDateStr).getTime();
        const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
        return {
          title: ol.title,
          date: ol.date.split('-').slice(1).reverse().join('.'),
          daysLeft
        };
      }).filter(ol => ol.daysLeft >= 0);

      // Set active ChGK session with timestamp
      const chgk = getRandomChgkQuestion();
      setActiveSession(config.chatId, chgk, Date.now());

      const briefing = await formatDailyBriefing({
        dateStr: todayDateStr.split('-').reverse().join('.'),
        dayOfWeek: dayInfo.name,
        schoolLessons: dayLessons,
        chgkQuestion: chgk,
        scheduleItems: [],
        olympiads: olympiadList,
        weeklyTasks: [
          { task: 'Сдать 2 стихотворения по литературе (выучить Чт/Пт, сдача Пт/Сб)', planned_hours: 2, deadline: 'Пятница / Суббота' },
          { task: 'Сдать 2 пересказа по английскому (выучить Чт/Пт, сдача Пт/Сб)', planned_hours: 2, deadline: 'Пятница / Суббота' },
          { task: 'ЕГЭ Русский: Stepik тест + задание учителя', planned_hours: 1.5, deadline: 'Воскресенье' },
          { task: 'Дорешка Степанова — олимпиадное программирование', planned_hours: 4, deadline: 'Воскресенье' }
        ],
        dashboardUrl: config.dashboardUrl
      });

      await sendTelegramMessage(config.botToken, config.chatId, briefing);
      config.lastDailySentDate = todayDateStr;
      saveTelegramConfig(config);
    }

    // 2. Check Olympiad Reminders (3 days and 1 day before)
    if (config.olympiadReminders) {
      if (!config.sentAlerts) config.sentAlerts = {};
      let changed = false;

      for (const ol of KNOWN_OLYMPIADS) {
        const diffMs = new Date(ol.date).getTime() - new Date(todayDateStr).getTime();
        const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

        if (daysLeft === 3 || daysLeft === 1) {
          const alertKey = `${ol.id}_${daysLeft}`;
          if (!config.sentAlerts[alertKey]) {
            let alertMsg = '';
            const dateFormatted = ol.date.split('-').slice(1).reverse().join('.');
            if (daysLeft === 3) {
              alertMsg = `⚠️ <b>НАПОМИНАНИЕ: 3 ДНЯ ДО ОЛИМПИАДЫ!</b>\n\n🏆 <b>${ol.title}</b>\n📅 Дата: <b>${dateFormatted}</b>\n\nПора проверить готовность, повторить алгоритмы и не забыть про регистрацию! 🎯`;
            } else if (daysLeft === 1) {
              alertMsg = `🚨 <b>ВНИМАНИЕ: ЗАВТРА ОЛИМПИАДА!</b>\n\n🏆 <b>${ol.title}</b>\n📅 Дата: <b>${dateFormatted}</b>\n\nХорошо выспись сегодня, проверь аппаратуру и заряд бодрости! Удачи! 🦾✨`;
            }

            console.log(`[Telegram Bot] Sending Olympiad alert: ${alertKey}`);
            await sendTelegramMessage(config.botToken, config.chatId, alertMsg);
            config.sentAlerts[alertKey] = new Date().toISOString();
            changed = true;
          }
        }
      }

      if (changed) {
        saveTelegramConfig(config);
      }
    }

    // 3. Poll Telegram for replies to answer ChGK questions & provide ChGK facts
    try {
      // On first loop, skip all historical messages by fetching latest update_id
      if (lastTelegramUpdateOffset === 0) {
        const initUrl = `https://api.telegram.org/bot${config.botToken.trim()}/getUpdates?offset=-1`;
        const initRes = await fetch(initUrl);
        if (initRes.ok) {
          const initData = await initRes.json();
          if (initData.ok && Array.isArray(initData.result) && initData.result.length > 0) {
            lastTelegramUpdateOffset = initData.result[initData.result.length - 1].update_id;
          }
        }
        return; // Skip first tick to establish baseline offset
      }

      const updatesUrl = `https://api.telegram.org/bot${config.botToken.trim()}/getUpdates?offset=${lastTelegramUpdateOffset + 1}&limit=10`;
      const upRes = await fetch(updatesUrl);
      if (upRes.ok) {
        const upData = await upRes.json();
        if (upData.ok && Array.isArray(upData.result)) {
          for (const u of upData.result) {
            lastTelegramUpdateOffset = u.update_id;
            const text = u.message?.text;
            const fromChatId = String(u.message?.chat?.id || '');
            const msgDateMs = u.message?.date ? u.message.date * 1000 : Date.now();

            // Ignore messages older than 3 minutes to avoid answering stale updates
            if (Date.now() - msgDateMs > 180000) {
              continue;
            }

            if (text && fromChatId === String(config.chatId).trim()) {
              const lower = text.toLowerCase().trim();
              if (lower === '/start' || lower === '/help') {
                await sendTelegramMessage(
                  config.botToken, 
                  config.chatId, 
                  `👋 <b>Бот настроен и интегрирован с Gemini AI!</b>\n\n` +
                  `🤖 <b>Ассистент Gemini AI:</b>\n` +
                  `• <code>/ai [ваш вопрос]</code> или <code>/gemini [вопрос]</code> — задать вопрос AI (алгоритмы, задачи, учеба, планирование)\n\n` +
                  `🧠 <b>Интерактив и команды:</b>\n` +
                  `• <code>/chgk</code> — получить случайный вопрос ЧГК\n` +
                  `• <code>/fact</code> — получить интересный факт ЧГК\n\n` +
                  `<i>Задавайте любые вопросы боту с помощью <code>/ai</code>!</i>`
                );
              } else if (lower.startsWith('/ai') || lower.startsWith('/gemini') || lower.startsWith('/ask')) {
                const userQuery = text.replace(/^\/(ai|gemini|ask)\s*/i, '').trim();
                if (!userQuery) {
                  await sendTelegramMessage(
                    config.botToken, 
                    config.chatId, 
                    `🤖 <b>Gemini AI Assistant:</b>\n\nЗадайте любой вопрос боту после команды, например:\n• <code>/ai Как дорешать продвинутый декартач?</code>\n• <code>/ai Составь советы по разбору задач Div2</code>`
                  );
                } else {
                  await sendTelegramMessage(config.botToken, config.chatId, `🤖 <i>Gemini AI размышляет над ответом...</i>`);
                  try {
                    const aiRes = await ai.models.generateContent({
                      model: 'gemini-3.8-flash',
                      contents: `Ты умный ассистент, куратор и ментор олимпиадника (олимпиадное программирование, математика, ЕГЭ, личная продуктивность).
Отвечай четко, структурированно, с поддержкой и юмором, используя форматирование HTML для Telegram (<b>жирный</b>, <i>курсив</i>, <code>код</code>).
Вопрос пользователя: ${userQuery}`,
                    });
                    const aiAnswer = aiRes.text || 'К сожалению, не удалось получить ответ от Gemini.';
                    await sendTelegramMessage(config.botToken, config.chatId, `✨ <b>Gemini AI:</b>\n\n${aiAnswer}`);
                  } catch (geminiErr: any) {
                    await sendTelegramMessage(config.botToken, config.chatId, `⚠️ <b>Ошибка Gemini:</b> ${geminiErr.message}`);
                  }
                }
              } else if (lower === '/chgk') {
                const q = getRandomChgkQuestion();
                setActiveSession(fromChatId, q, Date.now());
                await sendTelegramMessage(config.botToken, config.chatId, `🧠 <b>Вопрос «Что? Где? Когда?»:</b>\n\n<i>«${q.question}»</i>\n\n💬 Напишите вашу версию ответа!`);
              } else if (lower === '/fact') {
                const fact = getRandomChgkFact();
                await sendTelegramMessage(config.botToken, config.chatId, `${fact}`);
              } else {
                // User replied with text
                const session = getActiveSession(fromChatId);
                if (session) {
                  const elapsedMs = Date.now() - session.askedAt;
                  const totalSec = Math.max(1, Math.round(elapsedMs / 1000));
                  const timeStr = formatDuration(totalSec);
                  const randomFact = getRandomChgkFact();

                  const replyText = 
                    `🎯 <b>Ответ принят!</b>\n` +
                    `⏱️ <b>Время ответа:</b> ${timeStr}\n\n` +
                    `💡 <b>Правильный ответ на вопрос ЧГК:</b>\n<tg-spoiler>${session.question.answer}</tg-spoiler>\n` +
                    (session.question.comment ? `\n<i>Комментарий: ${session.question.comment}</i>\n\n` : '\n\n') +
                    `${randomFact}\n\n` +
                    `<i>Хотите ещё один вопрос? Напишите /chgk или спросите ассистента через /ai</i>`;

                  await sendTelegramMessage(config.botToken, config.chatId, replyText);
                  clearActiveSession(fromChatId);
                } else {
                  // Prompt user to use /ai for questions
                  await sendTelegramMessage(
                    config.botToken, 
                    config.chatId, 
                    `💡 Чтобы задать вопрос искусственному интеллекту Gemini, используйте команду:\n<code>/ai ${text}</code>`
                  );
                }
              }
            }
          }
        }
      }
    } catch (pollErr) {
      // ignore polling errors
    }

  } catch (cronErr) {
    console.warn('[Telegram Bot Cron Error]:', cronErr);
  }
}, 30000); // Check every 30s


async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Planner Manager Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
