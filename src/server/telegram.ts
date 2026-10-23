import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SCHOOL_SCHEDULE_11B } from '../data/schoolSchedule.ts';
import { getRandomChgkQuestion, getRandomChgkFact, type ChgkQuestion } from '../data/chgkDatabase.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_FILE = path.resolve(process.cwd(), 'data/telegram_config.json');

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  chatName?: string;
  enabled: boolean;
  dailyTime: string; // "07:00"
  olympiadReminders: boolean; // 3 and 1 days before
  dashboardUrl?: string; // AI Studio dashboard URL for pinned message
  lastDailySentDate?: string; // YYYY-MM-DD
  sentAlerts?: Record<string, string>; // `${taskId}_${daysLeft}` -> ISO timestamp
  activeHost?: 'railway' | 'dev' | 'both'; // Railway (24/7) vs AI Studio local container
  lastUpdateOffset?: number;
  geminiApiKey?: string;
}

export function loadTelegramConfig(): TelegramConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!parsed.activeHost) {
        parsed.activeHost = 'railway';
      }
      if (!parsed.geminiApiKey && process.env.GEMINI_API_KEY) {
        parsed.geminiApiKey = process.env.GEMINI_API_KEY;
      }
      return parsed;
    }
  } catch (err) {
    console.warn('Error reading telegram config:', err);
  }

  const envToken = process.env.TELEGRAM_BOT_TOKEN || '';
  const envChatId = process.env.TELEGRAM_CHAT_ID || '';

  return {
    botToken: envToken,
    chatId: envChatId,
    chatName: process.env.TELEGRAM_CHAT_NAME || '',
    enabled: Boolean(envToken && envChatId),
    dailyTime: process.env.TELEGRAM_DAILY_TIME || '07:00',
    olympiadReminders: true,
    dashboardUrl: process.env.TELEGRAM_DASHBOARD_URL || '',
    sentAlerts: {},
    activeHost: (process.env.TELEGRAM_ACTIVE_HOST as any) || 'railway',
    geminiApiKey: process.env.GEMINI_API_KEY || ''
  };
}

export function saveTelegramConfig(config: TelegramConfig): void {
  try {
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving telegram config:', err);
  }
}

// Global outgoing message deduplication cache
const recentOutgoingMessages = new Map<string, number>();

export async function sendTelegramMessage(
  botToken: string, 
  chatId: string, 
  text: string, 
  replyMarkup?: any
): Promise<{ success: boolean; messageId?: number; error?: string }> {
  if (!botToken || !chatId) {
    return { success: false, error: 'Не указан Bot Token или Chat ID' };
  }

  // Deduplicate identical outgoing messages to the same chat within 2.5 seconds
  const dedupKey = `${String(chatId).trim()}:${text.slice(0, 150)}`;
  const now = Date.now();
  const lastSent = recentOutgoingMessages.get(dedupKey) || 0;
  if (now - lastSent < 2500) {
    console.warn('[Telegram] Dropped duplicate outgoing message within 2.5s:', text.slice(0, 50));
    return { success: true };
  }
  recentOutgoingMessages.set(dedupKey, now);

  // Prune cache
  if (recentOutgoingMessages.size > 200) {
    for (const [k, t] of recentOutgoingMessages.entries()) {
      if (now - t > 10000) recentOutgoingMessages.delete(k);
    }
  }

  try {
    const url = `https://api.telegram.org/bot${botToken.trim()}/sendMessage`;
    const bodyPayload: any = {
      chat_id: chatId.trim(),
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false
    };

    if (replyMarkup) {
      bodyPayload.reply_markup = replyMarkup;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyPayload)
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      // Automatic fallback if HTML entities fail to parse (e.g. unescaped math or brackets from AI)
      if (data.description && (data.description.includes("can't parse entities") || data.description.includes('parse'))) {
        console.warn('[Telegram] HTML parse error, retrying without HTML parse_mode:', data.description);
        const plainText = text.replace(/<[^>]*>/g, '');
        const fallbackRes = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...bodyPayload,
            parse_mode: undefined,
            text: plainText
          })
        });
        const fallbackData = await fallbackRes.json();
        if (fallbackRes.ok && fallbackData.ok) {
          return { success: true, messageId: fallbackData.result?.message_id };
        }
      }
      return { success: false, error: data.description || `HTTP ${res.status}` };
    }

    return { success: true, messageId: data.result?.message_id };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function pinDashboardMessage(
  botToken: string,
  chatId: string,
  dashboardUrl: string
): Promise<{ success: boolean; messageId?: number; error?: string }> {
  if (!botToken || !chatId) {
    return { success: false, error: 'Не указан Bot Token или Chat ID' };
  }

  const cleanUrl = dashboardUrl && dashboardUrl.trim() ? dashboardUrl.trim() : 'https://ai.google.dev';

  const pinText = 
    `📌 <b>ЗАКРЕП: Дашборд 11Б — Подготовка к ВсОШ & ЕГЭ</b>\n\n` +
    `🎯 <b>Цели года (БВИ в ПМИ МФТИ / ВШЭ):</b>\n` +
    `• 🏆 Призёрство / Победа на Всеросе по информатике\n` +
    `• 🥇 Победы в перечневых олимпиадах 1 уровня (Высшая проба, Всесиб, Иннополис)\n` +
    `• 🛡️ Защитный рубеж ЕГЭ: Русский ≥ 85 | Инфа ≥ 95 | Профмат ≥ 95\n\n` +
    `🔗 <b>Ссылка на рабочий дашборд:</b>\n` +
    `<a href="${cleanUrl}">${cleanUrl}</a>\n\n` +
    `<i>Сообщение закреплено для быстрого перехода в любой момент! 🚀</i>`;

  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: '🌐 Открыть Дашборд AI Studio', url: cleanUrl }
      ]
    ]
  };

  const sendResult = await sendTelegramMessage(botToken, chatId, pinText, inlineKeyboard);
  if (!sendResult.success || !sendResult.messageId) {
    return { success: false, error: sendResult.error || 'Не удалось отправить сообщение' };
  }

  try {
    const pinUrl = `https://api.telegram.org/bot${botToken.trim()}/pinChatMessage`;
    const pinRes = await fetch(pinUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId.trim(),
        message_id: sendResult.messageId,
        disable_notification: false
      })
    });
    const pinData = await pinRes.json();
    if (!pinRes.ok || !pinData.ok) {
      console.warn('pinChatMessage warning:', pinData);
    }
  } catch (err: any) {
    console.warn('Error pinning message in Telegram:', err.message);
  }

  return { success: true, messageId: sendResult.messageId };
}

export async function detectTelegramChatId(botToken: string): Promise<{ success: boolean; chatId?: string; chatName?: string; error?: string }> {
  if (!botToken) {
    return { success: false, error: 'Укажите Bot Token' };
  }

  try {
    const url = `https://api.telegram.org/bot${botToken.trim()}/getUpdates?offset=-10`;
    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok || !data.ok) {
      return { success: false, error: data.description || 'Не удалось связаться с Telegram API' };
    }

    const updates = data.result || [];
    if (updates.length === 0) {
      return {
        success: false,
        error: 'Новых сообщений не найдено. Откройте своего бота в Telegram и отправьте ему команду /start или любое сообщение, затем нажмите кнопку снова!'
      };
    }

    // Get the latest message
    const lastUpdate = updates[updates.length - 1];
    const message = lastUpdate.message || lastUpdate.channel_post || lastUpdate.edited_message;

    if (!message || !message.chat) {
      return { success: false, error: 'В полученном обновлении отсутствует чат' };
    }

    const chatId = String(message.chat.id);
    const chatName = message.chat.username 
      ? `@${message.chat.username}` 
      : [message.chat.first_name, message.chat.last_name].filter(Boolean).join(' ') || `Chat ${chatId}`;

    return { success: true, chatId, chatName };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function getEkbWeather(): Promise<string> {
  try {
    const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=56.8389&longitude=60.6057&current_weather=true&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FYekaterinburg');
    if (!res.ok) return '⛅ <b>Погода в Екатеринбурге (UTC+5):</b> +5°C... +10°C, переменная облачность';
    const data = await res.json();
    const temp = Math.round(data.current_weather?.temperature ?? 8);
    const maxTemp = Math.round(data.daily?.temperature_2m_max?.[0] ?? temp);
    const minTemp = Math.round(data.daily?.temperature_2m_min?.[0] ?? temp - 4);
    const precipProb = data.daily?.precipitation_probability_max?.[0] ?? 10;

    let icon = '⛅';
    if (precipProb > 50) icon = '🌧️';
    else if (temp < 0) icon = '❄️';
    else if (temp > 18) icon = '☀️';

    const sign = (t: number) => (t > 0 ? `+${t}` : `${t}`);
    return `${icon} <b>Погода в Екатеринбурге на сегодня (UTC+5):</b> сейчас ${sign(temp)}°C (днём ${sign(minTemp)}°C... ${sign(maxTemp)}°C, вероятность осадков: ${precipProb}%)`;
  } catch (err) {
    return '⛅ <b>Погода в Екатеринбурге (UTC+5):</b> +8°C, переменная облачность';
  }
}

export async function formatDailyBriefing(params: {
  dateStr: string;
  dayOfWeek: string;
  schoolLessons: Array<{ num: number; timeStart?: string; timeEnd?: string; subject: string; room?: string; note?: string }>;
  scheduleItems: Array<{ start: string; end: string; task: string; planned_hours: number; category: string }>;
  olympiads: Array<{ title: string; date: string; daysLeft: number }>;
  weeklyTasks?: Array<{ task: string; category?: string; status?: string; planned_hours?: number; deadline?: string }>;
  dashboardUrl?: string;
  chgkQuestion?: ChgkQuestion;
}): Promise<string> {
  const { dateStr, dayOfWeek, schoolLessons, scheduleItems, olympiads, weeklyTasks, dashboardUrl } = params;

  const weatherStr = await getEkbWeather();
  const chgk = params.chgkQuestion || getRandomChgkQuestion();

  let msg = `🌅 <b>ПЛАН НА ДЕНЬ — ${dateStr} (${dayOfWeek}, Екб UTC+5)</b>\n\n`;

  // School lessons WITH LESSON TIMES as requested ("давай все таки оставим время уроков в расписании")
  if (schoolLessons && schoolLessons.length > 0) {
    msg += `🏫 <b>Школьные уроки (11Б класс):</b>\n`;
    schoolLessons.forEach(l => {
      const time = l.timeStart && l.timeEnd ? `<code>${l.timeStart}–${l.timeEnd}</code> ` : '';
      const room = l.room ? ` <i>[${l.room}]</i>` : '';
      const note = l.note ? ` <i>(${escapeHtml(l.note)})</i>` : '';
      msg += `  ${l.num}. ${time}<b>${escapeHtml(l.subject)}</b>${room}${note}\n`;
    });
    msg += `\n`;
  }

  // Tasks with deadlines this week as requested ("вместо долгов пусть показывает задачи с дедлайном на этой неделе... пересказы и сочинения")
  if (weeklyTasks && weeklyTasks.length > 0) {
    msg += `📌 <b>Задачи и дедлайны на эту неделю:</b>\n`;
    weeklyTasks.forEach(t => {
      let icon = '📝';
      if (t.task.toLowerCase().includes('стих') || t.task.toLowerCase().includes('пересказ') || t.task.toLowerCase().includes('англ')) icon = '🗣️';
      else if (t.task.toLowerCase().includes('русск') || t.task.toLowerCase().includes('сочин') || t.task.toLowerCase().includes('степик')) icon = '✍️';
      else if (t.task.toLowerCase().includes('степан') || t.task.toLowerCase().includes('олимп') || t.task.toLowerCase().includes('мат')) icon = '💻';

      const hours = t.planned_hours ? ` (${t.planned_hours}ч)` : '';
      const deadline = t.deadline ? ` [дедлайн: ${t.deadline}]` : '';
      msg += `  • ${icon} <b>${escapeHtml(t.task)}</b>${hours}<i>${deadline}</i>\n`;
    });
    msg += `\n`;
  } else {
    msg += `📌 <b>Задачи на неделю:</b>\n`;
    msg += `  • 🗣️ 2 стихотворения по литературе (учить Чт/Пт, сдача Пт/Сб)\n`;
    msg += `  • 🗣️ 2 пересказа по английскому (учить Чт/Пт, сдача Пт/Сб)\n`;
    msg += `  • ✍️ ЕГЭ Русский: курс Stepik + задание учителя\n\n`;
  }

  // After school activities
  if (scheduleItems && scheduleItems.length > 0) {
    msg += `⚡ <b>План после школы:</b>\n`;
    scheduleItems.forEach(s => {
      const time = s.start && s.end ? `${s.start}–${s.end}` : '';
      const hours = s.planned_hours ? ` (${s.planned_hours}ч)` : '';
      msg += `  • <code>${time}</code> <b>${escapeHtml(s.task)}</b>${hours}\n`;
    });
    msg += `\n`;
  } else {
    msg += `⚡ <b>План после школы:</b> Свободный вечер или индивидуальная подготовка.\n\n`;
  }

  // Upcoming Olympiads ONLY <= 7 days away as requested
  const validOlympiads = (olympiads || []).filter(ol => ol.daysLeft >= 0 && ol.daysLeft <= 7);
  if (validOlympiads.length > 0) {
    msg += `🏆 <b>Олимпиады в ближайшие 7 дней:</b>\n`;
    validOlympiads.forEach(ol => {
      let daysBadge = '';
      if (ol.daysLeft === 0) daysBadge = '🔥 СЕГОДНЯ!';
      else if (ol.daysLeft === 1) daysBadge = '🚨 ЗАВТРА!';
      else if (ol.daysLeft <= 3) daysBadge = `⚠️ через ${ol.daysLeft} дн.`;
      else daysBadge = `(через ${ol.daysLeft} дн.)`;

      msg += `  • <b>${ol.date}</b> — ${escapeHtml(ol.title)} ${daysBadge}\n`;
    });
    msg += `\n`;
  }

  // ChGK Question of the Day
  if (chgk) {
    msg += `🧠 <b>Вопрос «Что? Где? Когда?» дня:</b>\n`;
    msg += `<i>«${escapeHtml(chgk.question)}»</i>\n`;
    msg += `💬 <i>Отправьте ваш вариант ответа боту в ответ на это сообщение, и он проверит его и поделится фактом ЧГК!</i>\n\n`;
  }

  // Weather in Yekaterinburg at the bottom as requested ("пусть еще внизу говорит погоду на сегодня в екб")
  msg += `${weatherStr}\n\n`;

  if (dashboardUrl) {
    msg += `🔗 <i><a href="${dashboardUrl}">Открыть рабочий дашборд в AI Studio</a></i>\n\n`;
  }

  msg += `<i>Успешного дня и отличной подготовки! 🚀</i>`;
  return msg;
}

function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export const MAIN_MENU_KEYBOARD = {
  keyboard: [
    [{ text: '📅 На сегодня' }, { text: '🗓️ На завтра' }],
    [{ text: '📆 Выбрать день' }, { text: '🏆 Олимпиады' }],
    [{ text: '🧠 Вопрос ЧГК' }, { text: '💡 Факт ЧГК' }],
    [{ text: '🤖 Спросить Gemini' }]
  ],
  resize_keyboard: true,
  persistent: true
};

export const CHGK_QUESTION_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '💡 Показать ответ', callback_data: 'chgk_show_answer' },
      { text: '⏱️ 60 сек (минута)', callback_data: 'chgk_timer_60' }
    ],
    [
      { text: '⏭️ Следующий вопрос', callback_data: 'chgk_next' }
    ]
  ]
};

export const CHGK_ANSWER_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '⏭️ Следующий вопрос', callback_data: 'chgk_next' }
    ]
  ]
};

export const DAYS_INLINE_KEYBOARD = {
  inline_keyboard: [
    [
      { text: 'Пн (Понедельник)', callback_data: 'sch_Mon' },
      { text: 'Вт (Вторник)', callback_data: 'sch_Tue' }
    ],
    [
      { text: 'Ср (Среда)', callback_data: 'sch_Wed' },
      { text: 'Чт (Четверг)', callback_data: 'sch_Thu' }
    ],
    [
      { text: 'Пт (Пятница)', callback_data: 'sch_Fri' },
      { text: 'Сб (Суббота)', callback_data: 'sch_Sat' }
    ],
    [
      { text: 'Вс (Воскресенье)', callback_data: 'sch_Sun' }
    ]
  ]
};

export function formatDaySchedule(dayId: string): string {
  const dayNames: Record<string, string> = {
    'Mon': 'Понедельник',
    'Tue': 'Вторник',
    'Wed': 'Среда',
    'Thu': 'Четверг',
    'Fri': 'Пятница',
    'Sat': 'Суббота',
    'Sun': 'Воскресенье'
  };

  const dayName = dayNames[dayId] || dayId;
  const lessons = SCHOOL_SCHEDULE_11B.filter(l => l.day === dayId);

  let msg = `📅 <b>Расписание уроков 11Б — ${dayName}:</b>\n\n`;

  if (lessons.length === 0) {
    if (dayId === 'Sun') {
      msg += `🎉 <i>В воскресенье уроков в школе нет!</i>\n\n`;
      msg += `⚡ <b>Планы на воскресенье:</b>\n`;
      msg += `• Дорешка Степанова — олимпиадное программирование (4ч)\n`;
      msg += `• ЕГЭ Русский язык — курс Stepik (1.5ч)\n`;
      msg += `• Отдых и подготовка к новой неделе 🦾\n`;
    } else {
      msg += `<i>Нет уроков в этот день.</i>\n\n`;
    }
  } else {
    lessons.forEach(l => {
      const noteStr = l.note ? ` <i>(${l.note})</i>` : '';
      msg += `<b>${l.lessonNumber}.</b> <code>${l.timeStart}–${l.timeEnd}</code> — <b>${escapeHtml(l.subject)}</b> (${l.room})${noteStr}\n`;
    });
    msg += `\n`;
  }

  // Evening activities for that day
  const eveningActivities: Record<string, string[]> = {
    'Mon': ['15:30–17:00: ЧГК — тренировка (1.5ч)', '19:00–21:00: ДЮ — олимпиадная математика (2ч)'],
    'Tue': ['18:00–21:00: Дорешка олимпиадных задач / Степанов (3ч)'],
    'Wed': ['17:00–19:30: Олимпиадная математика / Физтех (2.5ч)'],
    'Thu': ['16:00–18:00: ЧГК — командный турнир (2ч)', '20:00–21:30: Литература & английский дедлайны (1.5ч)'],
    'Fri': ['18:00–21:00: Олимпиадное программирование — тренировка (3ч)'],
    'Sat': ['15:00–18:00: Codeforces контест / тренировочный тур (3ч)'],
    'Sun': ['12:00–16:00: Дорешка Степанова (4ч)', '17:00–18:30: ЕГЭ Русский Stepik (1.5ч)']
  };

  const evening = eveningActivities[dayId];
  if (evening && evening.length > 0) {
    msg += `⚡ <b>План после школы:</b>\n`;
    evening.forEach(act => {
      msg += `• ${escapeHtml(act)}\n`;
    });
  }

  return msg;
}


