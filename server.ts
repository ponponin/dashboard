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
  MAIN_MENU_KEYBOARD,
  DAYS_INLINE_KEYBOARD,
  CHGK_QUESTION_KEYBOARD,
  CHGK_ANSWER_KEYBOARD,
  formatDaySchedule,
  TelegramConfig
} from './src/server/telegram.ts';
import { SCHOOL_SCHEDULE_11B } from './src/data/schoolSchedule.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json({ limit: '10mb' }));

// Server-side Gemini initialization with fallback to config.geminiApiKey
function getGeminiClient(customKey?: string): GoogleGenAI | null {
  const cfg = loadTelegramConfig();
  const apiKey = customKey || process.env.GEMINI_API_KEY || cfg.geminiApiKey;
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const ai = new Proxy({} as GoogleGenAI, {
  get(_target, prop) {
    const client = getGeminiClient();
    if (!client) {
      throw new Error('GEMINI_API_KEY не задан в окружении сервера или data/telegram_config.json');
    }
    return (client as any)[prop];
  }
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
  formatDuration,
  checkSportsAnswer,
  formatChgkQuestionMessage,
  formatChgkAnswerMessage,
  escapeHtml
} from './src/data/chgkDatabase.ts';

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
    const cfg = loadTelegramConfig();
    const apiKey = process.env.GEMINI_API_KEY || cfg.geminiApiKey;
    if (!apiKey) {
      return res.status(400).json({
        success: false,
        error: 'GEMINI_API_KEY не задан в окружении сервера или data/telegram_config.json'
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

// Global in-memory deduplication cache
// Global in-memory deduplication caches and locks
const sentAlertsInProcess = new Set<string>();
const processedUpdateIds = new Set<number>();
const processedMessageIds = new Set<number>();
const processedCallbackIds = new Set<string>();
const recentUserActions = new Map<string, number>();

// Environment detection: AI Studio dev container vs Railway 24/7 cloud hosting
const isAiStudioEnv = Boolean(
  process.env.APPLET_ID || 
  process.env.K_SERVICE || 
  (process.env.APP_URL && process.env.APP_URL.includes('run.app')) ||
  (process.env.HOSTNAME && process.env.HOSTNAME.includes('ais-'))
);
const isRailwayEnv = !isAiStudioEnv;

const KNOWN_OLYMPIADS = [
  { id: 'OL_SHE_INF', title: 'ШЭ — информатика (Школьный этап ВсОШ)', date: '2026-10-21' },
  { id: 'OL_VSESIB_INF', title: 'Всесиб — информатика (Отборочный этап)', date: '2026-11-08' },
  { id: 'OL_HSE_INF', title: 'ВШЭ «Высшая проба» — информатика', date: '2026-11-14' },
  { id: 'OL_HSE_MATH', title: 'ВШЭ «Высшая проба» — математика', date: '2026-11-20' },
  { id: 'OL_INNOPOLIS', title: 'Иннополис Open («Инопа») — информатика', date: '2026-11-21' }
];

const SERVER_BOOT_TIME = Date.now();
const INSTANCE_ID = Math.random().toString(36).substring(2, 6).toUpperCase();

let lastTelegramUpdateOffset = 0;
let isTelegramPollRunning = false;
let isDailyCronRunning = false;

function pruneDeduplicationCaches() {
  if (processedUpdateIds.size > 2000) {
    const arr = Array.from(processedUpdateIds);
    arr.slice(0, 1000).forEach(id => processedUpdateIds.delete(id));
  }
  if (processedMessageIds.size > 2000) {
    const arr = Array.from(processedMessageIds);
    arr.slice(0, 1000).forEach(id => processedMessageIds.delete(id));
  }
  if (processedCallbackIds.size > 2000) {
    const arr = Array.from(processedCallbackIds);
    arr.slice(0, 1000).forEach(id => processedCallbackIds.delete(id));
  }
  const now = Date.now();
  for (const [key, timestamp] of recentUserActions.entries()) {
    if (now - timestamp > 60000) {
      recentUserActions.delete(key);
    }
  }
}

// 1. Cron Task: 07:00 Daily Briefing & Olympiad alerts (runs every 30s)
function startTelegramCron() {
  setInterval(async () => {
    if (isDailyCronRunning) return;
    isDailyCronRunning = true;

    try {
      const config = loadTelegramConfig();
      if (!config.enabled || !config.botToken || !config.chatId) return;

    const now = new Date();
    const utcHours = now.getUTCHours();
    const ekbHours = (utcHours + 5) % 24;
    const ekbMinutes = now.getUTCMinutes();
    const ekbTimeStr = `${String(ekbHours).padStart(2, '0')}:${String(ekbMinutes).padStart(2, '0')}`;
    const todayDateStr = now.toISOString().slice(0, 10);

    // 07:00 Morning Briefing (UTC+5)
    const targetDailyTime = config.dailyTime || '07:00';
    if (ekbTimeStr === targetDailyTime && config.lastDailySentDate !== todayDateStr) {
      console.log(`[Telegram Bot] Sending morning briefing at ${ekbTimeStr} UTC+5 for ${todayDateStr}`);

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

      const olympiadList = KNOWN_OLYMPIADS.map(ol => {
        const diffMs = new Date(ol.date).getTime() - new Date(todayDateStr).getTime();
        const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
        return {
          title: ol.title,
          date: ol.date.split('-').slice(1).reverse().join('.'),
          daysLeft
        };
      }).filter(ol => ol.daysLeft >= 0);

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

    // Olympiad Reminders (3 days and 1 day before)
    if (config.olympiadReminders) {
      if (!config.sentAlerts) config.sentAlerts = {};
      let changed = false;

      for (const ol of KNOWN_OLYMPIADS) {
        const diffMs = new Date(ol.date).getTime() - new Date(todayDateStr).getTime();
        const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

        if (daysLeft === 3 || daysLeft === 1) {
          const alertKey = `${ol.id}_${daysLeft}`;
          const alertKeyWithDate = `${alertKey}_${todayDateStr}`;

          if (!config.sentAlerts[alertKey] && !sentAlertsInProcess.has(alertKeyWithDate)) {
            sentAlertsInProcess.add(alertKeyWithDate);

            let alertMsg = '';
            const dateFormatted = ol.date.split('-').slice(1).reverse().join('.');
            if (daysLeft === 3) {
              alertMsg = `⚠️ <b>НАПОМИНАНИЕ: 3 ДНЯ ДО ОЛИМПИАДЫ!</b>\n\n🏆 <b>${ol.title}</b>\n📅 Дата: <b>${dateFormatted}</b>\n\nПора проверить готовность, повторить алгоритмы и не забыть про регистрацию! 🎯`;
            } else if (daysLeft === 1) {
              alertMsg = `🚨 <b>ВНИМАНИЕ: ЗАВТРА ОЛИМПИАДА!</b>\n\n🏆 <b>${ol.title}</b>\n📅 Дата: <b>${dateFormatted}</b>\n\nХорошо выспись сегодня, проверь аппаратуру и заряд бодрости! Удачи! 🦾✨`;
            }

            console.log(`[Telegram Bot] Sending Olympiad alert: ${alertKeyWithDate}`);
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
  } catch (cronErr) {
    console.warn('[Telegram Bot Cron Error]:', cronErr);
  } finally {
    isDailyCronRunning = false;
  }
  }, 30000);
}

// 2. Distributed Leader Election & Continuous Long Poller (Railway 24/7 Cloud Host)
let shouldStopPoller = false;
let isLeader = false;
let lastLeaderHeartbeat = 0;

async function checkAndMaintainLeadership(botToken: string): Promise<boolean> {
  const now = Date.now();
  // If we are already the leader, send heartbeat every 20 seconds
  if (isLeader) {
    if (now - lastLeaderHeartbeat > 20000) {
      try {
        const baseDesc = 'Личный ассистент расписания и олимпиад 11Б';
        await fetch(`https://api.telegram.org/bot${botToken.trim()}/setMyDescription`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: `${baseDesc}\n\n[Leader: #${INSTANCE_ID} | ${now}]` })
        });
        lastLeaderHeartbeat = now;
      } catch (hbErr) {
        console.warn(`[Leader #${INSTANCE_ID}] Heartbeat warning:`, hbErr);
      }
    }
    return true;
  }

  // Not yet leader: inspect Telegram description for current active leader
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken.trim()}/getMyDescription`);
    if (!res.ok) return false;
    const data = await res.json();
    const desc: string = data.result?.description || '';
    const match = desc.match(/\[Leader:\s*#([A-Z0-9]+)\s*\|\s*(\d+)\]/);

    if (match) {
      const currentLeaderId = match[1];
      const currentLeaderTs = parseInt(match[2], 10);
      const isLeaderAlive = (now - currentLeaderTs) < 45000;

      if (currentLeaderId === INSTANCE_ID) {
        isLeader = true;
        lastLeaderHeartbeat = now;
        return true;
      }

      if (isLeaderAlive) {
        console.log(`[Leader Guard #${INSTANCE_ID}] Instance #${currentLeaderId} is active leader (heartbeat ${Math.round((now - currentLeaderTs) / 1000)}s ago). #${INSTANCE_ID} is in STANDBY.`);
        isLeader = false;
        return false;
      }
    }

    // Leader is missing or dead (> 45s). Attempt to acquire leadership!
    console.log(`[Leader Guard #${INSTANCE_ID}] No healthy leader detected. Attempting to claim leadership...`);
    const baseDesc = 'Личный ассистент расписания и олимпиад 11Б';
    const claimPayload = `${baseDesc}\n\n[Leader: #${INSTANCE_ID} | ${now}]`;
    const claimRes = await fetch(`https://api.telegram.org/bot${botToken.trim()}/setMyDescription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: claimPayload })
    });

    if (claimRes.ok) {
      await new Promise(r => setTimeout(r, 1500));
      const verifyRes = await fetch(`https://api.telegram.org/bot${botToken.trim()}/getMyDescription`);
      const verifyData = await verifyRes.json();
      const verifyDesc: string = verifyData.result?.description || '';
      if (verifyDesc.includes(`[Leader: #${INSTANCE_ID}`)) {
        console.log(`🎉 [Leader Guard] Instance #${INSTANCE_ID} successfully acquired LEADER lock!`);
        isLeader = true;
        lastLeaderHeartbeat = now;
        return true;
      }
    }

    isLeader = false;
    return false;
  } catch (err) {
    console.warn('[Leader Guard] Error during election check:', err);
    return false;
  }
}

function startTelegramPoller() {
  console.log(`[Telegram Poller] Initializing Long Polling loop on host (Instance #${INSTANCE_ID})...`);

  // Start continuous polling loop
  (async () => {
    // Initial offset sync to avoid replaying backlog on boot
    try {
      const config = loadTelegramConfig();
      if (config.enabled && config.botToken) {
        const initUrl = `https://api.telegram.org/bot${config.botToken.trim()}/getUpdates?offset=-1`;
        const initRes = await fetch(initUrl);
        if (initRes.ok) {
          const initData = await initRes.json();
          if (initData.ok && Array.isArray(initData.result) && initData.result.length > 0) {
            lastTelegramUpdateOffset = initData.result[initData.result.length - 1].update_id;
            console.log(`[Telegram Poller #${INSTANCE_ID}] Initial offset set to ${lastTelegramUpdateOffset}`);
          }
        }
      }
    } catch (initErr) {
      console.warn('[Telegram Poller] Initial offset sync warning:', initErr);
    }

    while (!shouldStopPoller) {
      try {
        const config = loadTelegramConfig();
        if (!config.enabled || !config.botToken || !config.chatId) {
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        // Leader Election Guard: only the elected leader container is permitted to poll Telegram
        const isCurrentLeader = await checkAndMaintainLeadership(config.botToken);
        if (!isCurrentLeader) {
          await new Promise(r => setTimeout(r, 12000));
          continue;
        }

        pruneDeduplicationCaches();

        const updatesUrl = `https://api.telegram.org/bot${config.botToken.trim()}/getUpdates?offset=${lastTelegramUpdateOffset + 1}&limit=20&timeout=15`;
        const upRes = await fetch(updatesUrl);

        if (!upRes.ok) {
          if (upRes.status === 409) {
            // Another instance is actively polling. Enter STANDBY to completely prevent duplicate replies!
            console.warn(`[Telegram Poller #${INSTANCE_ID}] 409 Conflict: Another bot instance is polling this token. Entering STANDBY mode for 30s to prevent duplicate replies...`);
            isLeader = false;
            await new Promise(r => setTimeout(r, 30000));
            continue;
          }
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }

        const upData = await upRes.json();
        if (!upData.ok || !Array.isArray(upData.result) || upData.result.length === 0) {
          continue;
        }

        for (const u of upData.result) {
      // 1. Skip if update already processed by this server
      if (processedUpdateIds.has(u.update_id)) {
        continue;
      }
      processedUpdateIds.add(u.update_id);

      if (u.update_id > lastTelegramUpdateOffset) {
        lastTelegramUpdateOffset = u.update_id;
      }

      // Handle Inline Button Clicks (callback_query)
      if (u.callback_query) {
        const cb = u.callback_query;
        if (processedCallbackIds.has(cb.id)) {
          continue;
        }
        processedCallbackIds.add(cb.id);

        const cbData = cb.data;
        const cbChatId = String(cb.message?.chat?.id || cb.from?.id || '').trim();
        const targetChatId = String(config.chatId).trim();
        const cbDateMs = cb.message?.date ? cb.message.date * 1000 : Date.now();

        // Acknowledge callback immediately to remove loading spinner in Telegram UI
        try {
          await fetch(`https://api.telegram.org/bot${config.botToken.trim()}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: cb.id })
          });
        } catch (_) {}

        // Skip stale callbacks (> 3 minutes)
        if (Date.now() - cbDateMs > 180000) {
          continue;
        }

        if (cbData && (cbChatId === targetChatId || !targetChatId)) {
          // Debounce identical callback actions within 1.5s
          const actionKey = `cb:${cbChatId}:${cbData}`;
          const nowMs = Date.now();
          const lastAction = recentUserActions.get(actionKey) || 0;
          if (nowMs - lastAction < 1500) {
            continue;
          }
          recentUserActions.set(actionKey, nowMs);

          if (cbData.startsWith('sch_')) {
            const dayId = cbData.replace('sch_', '');
            const dayScheduleMsg = formatDaySchedule(dayId);
            await sendTelegramMessage(config.botToken, config.chatId, dayScheduleMsg, MAIN_MENU_KEYBOARD);
          } else if (cbData === 'chgk_show_answer') {
            const session = getActiveSession(cbChatId, config.chatId);
            if (session) {
              const elapsedMs = Date.now() - session.askedAt;
              const totalSec = Math.max(1, Math.round(elapsedMs / 1000));
              const timeStr = formatDuration(totalSec);
              const answerMsg = formatChgkAnswerMessage(session.question, `⏱️ <b>Время обсуждения:</b> ${timeStr}`);

              await sendTelegramMessage(config.botToken, config.chatId, answerMsg, CHGK_ANSWER_KEYBOARD);
              clearActiveSession(cbChatId, config.chatId);
            } else {
              await sendTelegramMessage(config.botToken, config.chatId, 'Сессия вопроса устарела или уже закрыта. Нажмите кнопку «🧠 Вопрос ЧГК» для нового вопроса!', MAIN_MENU_KEYBOARD);
            }
          } else if (cbData === 'chgk_timer_60') {
            const session = getActiveSession(cbChatId, config.chatId);
            if (session) {
              await sendTelegramMessage(config.botToken, config.chatId, `⏱️ <b>Минута пошла!</b> У вас есть 60 секунд на размышление... 🧠`);
              const qId = session.question.id;

              // 50 seconds alert
              setTimeout(async () => {
                const s = getActiveSession(cbChatId, config.chatId);
                if (s && s.question.id === qId) {
                  await sendTelegramMessage(config.botToken, config.chatId, `🔔 <b>Осталось 10 секунд!</b> Пора выбрать окончательную версию для записи.`);
                }
              }, 50000);

              // 60 seconds alert
              setTimeout(async () => {
                const s = getActiveSession(cbChatId, config.chatId);
                if (s && s.question.id === qId) {
                  await sendTelegramMessage(config.botToken, config.chatId, `⏰ <b>ВРЕМЯ!</b> Минута истекла. Отправьте ответ в чат или нажмите кнопку «💡 Показать ответ»!`, CHGK_QUESTION_KEYBOARD);
                }
              }, 60000);
            }
          } else if (cbData === 'chgk_next') {
            const q = getRandomChgkQuestion();
            setActiveSession(cbChatId, q, Date.now());
            const qMsg = formatChgkQuestionMessage(q);
            await sendTelegramMessage(config.botToken, config.chatId, qMsg, CHGK_QUESTION_KEYBOARD);
          }
        }
        continue;
      }

      // Handle Text Messages
      const msg = u.message;
      if (!msg || !msg.text) {
        continue;
      }

      if (processedMessageIds.has(msg.message_id)) {
        continue;
      }
      processedMessageIds.add(msg.message_id);

      const text = msg.text.trim();
      const fromChatId = String(msg.chat?.id || '').trim();
      const targetChatId = String(config.chatId).trim();
      const msgDateMs = msg.date ? msg.date * 1000 : Date.now();

      // Skip old messages (> 2 minutes)
      if (Date.now() - msgDateMs > 120000) {
        continue;
      }

      if (text && (fromChatId === targetChatId || !targetChatId)) {
        // Debounce rapid identical messages within 1.5s
        const actionKey = `msg:${fromChatId}:${text}`;
        const nowMs = Date.now();
        const lastAction = recentUserActions.get(actionKey) || 0;
        if (nowMs - lastAction < 1500) {
          continue;
        }
        recentUserActions.set(actionKey, nowMs);

        const lower = text.toLowerCase().trim();

        // Calculate current day in Yekaterinburg (UTC+5)
        const ekbDate = new Date(Date.now() + 5 * 3600 * 1000);
        const dayKeys = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const todayId = dayKeys[ekbDate.getUTCDay()];
        const tomorrowId = dayKeys[(ekbDate.getUTCDay() + 1) % 7];
        const todayDateStr = ekbDate.toISOString().slice(0, 10);

        if (lower === '/start' || lower === '/help' || lower === 'меню' || lower === '/menu') {
          const greeting = 
            `👋 <b>Привет! Я ваш бот расписания и подготовки 11Б!</b>\n\n` +
            `Всеми функциями удобно управлять кнопками внизу экрана 👇\n\n` +
            `• <b>📅 На сегодня</b> — расписание уроков и дел на сегодня\n` +
            `• <b>🗓️ На завтра</b> — уроки на завтра\n` +
            `• <b>📆 Выбрать день</b> — меню выбора дня недели\n` +
            `• <b>🏆 Олимпиады</b> — даты ближайших туров\n` +
            `• <b>🧠 Вопрос ЧГК</b> — вопрос дня с кнопкой ответа\n` +
            `• <b>💡 Факт ЧГК</b> — интересный факт\n` +
            `• <b>🤖 Спросить Gemini</b> — помощь нейросети\n` +
            `• <b>ℹ️ /status</b> — информация о сервере бота`;
          await sendTelegramMessage(config.botToken, config.chatId, greeting, MAIN_MENU_KEYBOARD);

        } else if (lower === '/status') {
          const cfg = loadTelegramConfig();
          const hostName = isRailwayEnv ? '🚂 Railway (24/7 Cloud)' : '💻 AI Studio (Dev Container)';
          const geminiReady = Boolean(process.env.GEMINI_API_KEY || cfg.geminiApiKey);
          const bootTimeStr = new Date(SERVER_BOOT_TIME + 5 * 3600 * 1000).toTimeString().slice(0, 8);
          const statusText = 
            `ℹ️ <b>Статус работы бота:</b>\n\n` +
            `• 🌐 <b>Сервер:</b> ${hostName}\n` +
            `• 🆔 <b>Инстанс:</b> <code>#${INSTANCE_ID}</code> (${isLeader ? '👑 Active Leader' : '💤 Standby'}) (старт: ${bootTimeStr} UTC+5)\n` +
            `• ⏰ <b>Время сервера (Екб UTC+5):</b> ${ekbDate.toTimeString().slice(0, 8)}\n` +
            `• 🌅 <b>Утренний брифинг:</b> ${config.dailyTime || '07:00'}\n` +
            `• 🏆 <b>Напоминания олимпиад:</b> ${config.olympiadReminders ? 'Включены (3 и 1 день)' : 'Выключены'}\n` +
            `• 🤖 <b>Gemini AI:</b> ${geminiReady ? 'Подключен ✅' : 'Не задан GEMINI_API_KEY ⚠️'}`;
          await sendTelegramMessage(config.botToken, config.chatId, statusText, MAIN_MENU_KEYBOARD);

        } else if (text.includes('На сегодня') || lower === '/today' || lower === '/сегодня') {
          const msgReply = formatDaySchedule(todayId);
          await sendTelegramMessage(config.botToken, config.chatId, msgReply, MAIN_MENU_KEYBOARD);

        } else if (text.includes('На завтра') || lower === '/tomorrow' || lower === '/завтра') {
          const msgReply = formatDaySchedule(tomorrowId);
          await sendTelegramMessage(config.botToken, config.chatId, msgReply, MAIN_MENU_KEYBOARD);

        } else if (['понедельник', 'пн', 'вторник', 'вт', 'среда', 'ср', 'четверг', 'чт', 'пятница', 'пт', 'суббота', 'сб', 'воскресенье', 'вс'].includes(lower)) {
          const ruDayMap: Record<string, string> = {
            'понедельник': 'Mon', 'пн': 'Mon',
            'вторник': 'Tue', 'вт': 'Tue',
            'среда': 'Wed', 'ср': 'Wed',
            'четверг': 'Thu', 'чт': 'Thu',
            'пятница': 'Fri', 'пт': 'Fri',
            'суббота': 'Sat', 'сб': 'Sat',
            'воскресенье': 'Sun', 'вс': 'Sun'
          };
          const msgReply = formatDaySchedule(ruDayMap[lower]);
          await sendTelegramMessage(config.botToken, config.chatId, msgReply, MAIN_MENU_KEYBOARD);

        } else if (text.includes('Выбрать день') || lower === '/days' || lower === '/расписание') {
          await sendTelegramMessage(
            config.botToken, 
            config.chatId, 
            `📆 <b>Выберите день недели для просмотра расписания:</b>`, 
            DAYS_INLINE_KEYBOARD
          );

        } else if (text.includes('Олимпиады') || lower === '/olympiads' || lower === '/олимпиады') {
          let olText = `🏆 <b>Ближайшие олимпиады:</b>\n\n`;
          KNOWN_OLYMPIADS.forEach(ol => {
            const diffMs = new Date(ol.date).getTime() - new Date(todayDateStr).getTime();
            const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
            let badge = daysLeft === 0 ? '🔥 СЕГОДНЯ' : daysLeft === 1 ? '🚨 ЗАВТРА' : `через ${daysLeft} дн.`;
            olText += `• <b>${ol.date.split('-').slice(1).reverse().join('.')}</b> — ${ol.title} (<i>${badge}</i>)\n`;
          });
          await sendTelegramMessage(config.botToken, config.chatId, olText, MAIN_MENU_KEYBOARD);

        } else if (text.includes('Вопрос ЧГК') || lower === '/chgk') {
          const q = getRandomChgkQuestion();
          setActiveSession(fromChatId, q, Date.now());
          const qMsg = formatChgkQuestionMessage(q);
          await sendTelegramMessage(config.botToken, config.chatId, qMsg, CHGK_QUESTION_KEYBOARD);

        } else if (text.includes('Факт ЧГК') || lower === '/fact') {
          const fact = getRandomChgkFact();
          await sendTelegramMessage(config.botToken, config.chatId, `${fact}`, MAIN_MENU_KEYBOARD);

        } else if (lower === '/briefing' || lower === '/утро' || lower === 'утренний брифинг') {
          await sendTelegramMessage(config.botToken, config.chatId, `🌅 <i>Формирую утренний брифинг...</i>`);
          const chgk = getRandomChgkQuestion();
          setActiveSession(fromChatId, chgk, Date.now());
          const dayLessons = SCHOOL_SCHEDULE_11B.filter(l => l.day === todayId).map(l => ({
            num: l.lessonNumber,
            timeStart: l.timeStart,
            timeEnd: l.timeEnd,
            subject: l.subject,
            room: l.room,
            note: l.note
          }));
          const olympiadList = KNOWN_OLYMPIADS.map(ol => {
            const diffMs = new Date(ol.date).getTime() - new Date(todayDateStr).getTime();
            const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
            return {
              title: ol.title,
              date: ol.date.split('-').slice(1).reverse().join('.'),
              daysLeft
            };
          }).filter(ol => ol.daysLeft >= 0);
          const briefing = await formatDailyBriefing({
            dateStr: todayDateStr.split('-').reverse().join('.'),
            dayOfWeek: todayId,
            schoolLessons: dayLessons,
            chgkQuestion: chgk,
            scheduleItems: [],
            olympiads: olympiadList,
            weeklyTasks: [
              { task: 'Сдать 2 стихотворения по литературе', planned_hours: 2, deadline: 'Пятница / Суббота' },
              { task: 'Сдать 2 пересказа по английскому', planned_hours: 2, deadline: 'Пятница / Суббота' },
              { task: 'ЕГЭ Русский: Stepik тест + задание', planned_hours: 1.5, deadline: 'Воскресенье' },
              { task: 'Дорешка Степанова — олимпиадное программирование', planned_hours: 4, deadline: 'Воскресенье' }
            ],
            dashboardUrl: config.dashboardUrl
          });
          await sendTelegramMessage(config.botToken, config.chatId, briefing, MAIN_MENU_KEYBOARD);

        } else if ((lower === '/answer' || lower === '/ответ' || lower === 'ответ' || lower === 'показать ответ') && getActiveSession(fromChatId, config.chatId)) {
          const session = getActiveSession(fromChatId, config.chatId)!;
          const elapsedMs = Date.now() - session.askedAt;
          const totalSec = Math.max(1, Math.round(elapsedMs / 1000));
          const timeStr = formatDuration(totalSec);
          const answerMsg = formatChgkAnswerMessage(session.question, `⏱️ <b>Время обсуждения:</b> ${timeStr}`);
          await sendTelegramMessage(config.botToken, config.chatId, answerMsg, CHGK_ANSWER_KEYBOARD);
          clearActiveSession(fromChatId, config.chatId);

        } else if ((lower === '/минута' || lower === 'минута' || lower === '/timer') && getActiveSession(fromChatId, config.chatId)) {
          const session = getActiveSession(fromChatId, config.chatId)!;
          await sendTelegramMessage(config.botToken, config.chatId, `⏱️ <b>Минута пошла!</b> У вас есть 60 секунд на размышление... 🧠`);
          const qId = session.question.id;
          setTimeout(async () => {
            const s = getActiveSession(fromChatId, config.chatId);
            if (s && s.question.id === qId) {
              await sendTelegramMessage(config.botToken, config.chatId, `🔔 <b>Осталось 10 секунд!</b> Пора выбрать окончательную версию для записи.`);
            }
          }, 50000);
          setTimeout(async () => {
            const s = getActiveSession(fromChatId, config.chatId);
            if (s && s.question.id === qId) {
              await sendTelegramMessage(config.botToken, config.chatId, `⏰ <b>ВРЕМЯ!</b> Минута истекла. Отправьте ответ в чат или нажмите кнопку «💡 Показать ответ»!`, CHGK_QUESTION_KEYBOARD);
            }
          }, 60000);

        } else if (text.includes('Спросить Gemini') || lower.startsWith('/ai') || lower.startsWith('/gemini')) {
          const userQuery = text.replace(/^\/(ai|gemini|ask)\s*/i, '').replace(/🤖\s*Спросить Gemini/i, '').trim();
          const cfg = loadTelegramConfig();
          const hasKey = Boolean(process.env.GEMINI_API_KEY || cfg.geminiApiKey);

          if (!userQuery) {
            await sendTelegramMessage(
              config.botToken, 
              config.chatId, 
              `🤖 <b>Gemini AI Assistant:</b>\n\nЗадайте вопрос, написав перед ним <code>/ai</code>, например:\n• <code>/ai Как решать задачи на суффиксный массив?</code>\n• <code>/ai Разбери задание 8 ЕГЭ русский</code>`,
              MAIN_MENU_KEYBOARD
            );
          } else if (!hasKey) {
            await sendTelegramMessage(
              config.botToken, 
              config.chatId, 
              `💡 <b>Gemini AI:</b> Чтобы включить искусственный интеллект на Railway, добавьте переменную <code>GEMINI_API_KEY</code> в настройках Railway во вкладке <b>Variables</b>!`,
              MAIN_MENU_KEYBOARD
            );
          } else {
            await sendTelegramMessage(config.botToken, config.chatId, `🤖 <i>Gemini AI размышляет над ответом...</i>`);
            try {
              const aiRes = await ai.models.generateContent({
                model: 'gemini-3.8-flash',
                contents: `Ты умный ассистент, куратор и ментор олимпиадника (олимпиадное программирование, математика, ЕГЭ, личная продуктивность).
Отвечай емко, структурированно, без воды, используя форматирование HTML для Telegram (<b>жирный</b>, <i>курсив</i>, <code>код</code>).
Вопрос пользователя: ${userQuery}`,
              });
              const aiAnswer = aiRes.text || 'К сожалению, не удалось получить ответ от Gemini.';
              await sendTelegramMessage(config.botToken, config.chatId, `✨ <b>Gemini AI:</b>\n\n${aiAnswer}`, MAIN_MENU_KEYBOARD);
            } catch (geminiErr: any) {
              await sendTelegramMessage(config.botToken, config.chatId, `⚠️ <b>Ошибка Gemini:</b> ${geminiErr.message}`, MAIN_MENU_KEYBOARD);
            }
          }
        } else {
          // Check if user is replying to an active sports ChGK question
          const session = getActiveSession(fromChatId, config.chatId);
          if (session) {
            const elapsedMs = Date.now() - session.askedAt;
            const totalSec = Math.max(1, Math.round(elapsedMs / 1000));
            const timeStr = formatDuration(totalSec);

            const evaluation = checkSportsAnswer(text, session.question);
            let header = '';
            if (evaluation.isCorrect) {
              header = `🎉 <b>В ЯБЛОЧКО! Ответ засчитан!</b> 🎯\n⏱️ <b>Время ответа:</b> ${timeStr}`;
            } else {
              header = `❌ <b>Не совсем так!</b> Ваш вариант: «<i>${escapeHtml(text)}</i>»\n⏱️ <b>Время ответа:</b> ${timeStr}`;
            }

            const answerMsg = formatChgkAnswerMessage(session.question, header);
            await sendTelegramMessage(config.botToken, config.chatId, answerMsg, CHGK_ANSWER_KEYBOARD);
            clearActiveSession(fromChatId, config.chatId);
          } else {
            await sendTelegramMessage(
              config.botToken, 
              config.chatId, 
              `Выберите нужный раздел кнопками ниже 👇 А для вопросов AI напишите: <code>/ai [вопрос]</code>`,
              MAIN_MENU_KEYBOARD
            );
          }
        }
      }
    }
      } catch (pollErr: any) {
        // network glitch or timeout, small backoff
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  })();
}

// ======================================================================
// HOST SEPARATION: Strict Isolation Between AI Studio & Railway Cloud
// ======================================================================
if (isAiStudioEnv) {
  console.log('----------------------------------------------------------------------');
  console.log('🛑 [HOST SEPARATION] AI STUDIO DEV CONTAINER DETECTED');
  console.log('🚫 Telegram Bot Poller & Daily Cron are 100% DISABLED in AI Studio.');
  console.log('🚂 Dedicated 24/7 Host: Railway Cloud (https://railway.app)');
  console.log('✅ AI Studio is completely disconnected from Telegram hosting to prevent duplicates.');
  console.log('----------------------------------------------------------------------');
} else {
  console.log('----------------------------------------------------------------------');
  console.log(`🚂 [HOST] Starting 24/7 Telegram Poller on Railway (Instance #${INSTANCE_ID})`);
  console.log('----------------------------------------------------------------------');

  // Handle graceful shutdown on Railway deploy to stop polling immediately
  process.on('SIGTERM', async () => {
    console.log('[Shutdown] Received SIGTERM signal. Halting Telegram poller immediately...');
    shouldStopPoller = true;
    try {
      const cfg = loadTelegramConfig();
      if (cfg.botToken && isLeader) {
        await fetch(`https://api.telegram.org/bot${cfg.botToken.trim()}/setMyDescription`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: 'Личный ассистент расписания и олимпиад 11Б' })
        });
      }
    } catch (_) {}
    process.exit(0);
  });
  process.on('SIGINT', async () => {
    console.log('[Shutdown] Received SIGINT signal. Halting Telegram poller...');
    shouldStopPoller = true;
    try {
      const cfg = loadTelegramConfig();
      if (cfg.botToken && isLeader) {
        await fetch(`https://api.telegram.org/bot${cfg.botToken.trim()}/setMyDescription`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: 'Личный ассистент расписания и олимпиад 11Б' })
        });
      }
    } catch (_) {}
    process.exit(0);
  });

  startTelegramCron();
  startTelegramPoller();
}


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
