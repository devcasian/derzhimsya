// derzhimsya — Telegram webhook.
// Deploy with "Verify JWT" DISABLED: Telegram cannot send a Supabase JWT.
// Authenticity is enforced by the secret token header instead.

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")!;
const SITE_URL = Deno.env.get("SITE_URL")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MONTHS_GENITIVE = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

function formatDate(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  return `${Number(day)} ${MONTHS_GENITIVE[Number(month) - 1]}`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function days(n: number): string {
  return `${n} ${plural(n, "день", "дня", "дней")}`;
}

interface Participant {
  id: string;
  name: string;
  habit: string;
  question: string;
  telegram_chat_id: number;
}

interface Day { date: string; status: string }

interface Stats {
  today: string;
  graceDays: number;
  participants: Array<{
    id: string; name: string; habit: string;
    currentStreak: number; bestStreak: number;
    totalSuccess: number; totalFail: number;
    days: Day[];
  }>;
  pair: { currentStreak: number; bestStreak: number; totalDays: number; days: Day[] };
}

async function db(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`postgrest ${res.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}

async function telegram(method: string, payload: unknown): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error(`telegram ${method} failed:`, await res.text());
}

async function loadStats(): Promise<Stats> {
  return await db("rpc/stats", { method: "POST", body: "{}" }) as Stats;
}

async function findParticipant(chatId: number): Promise<Participant | null> {
  const rows = await db(
    `participants?telegram_chat_id=eq.${chatId}&select=id,name,habit,question,telegram_chat_id`,
  ) as Participant[];
  return rows[0] ?? null;
}

async function allParticipants(): Promise<Participant[]> {
  return await db(
    "participants?select=id,name,habit,question,telegram_chat_id&order=sort_order",
  ) as Participant[];
}

function checkinKeyboard(date: string) {
  return {
    inline_keyboard: [[
      { text: "✅ Держался", callback_data: `c:${date}:1` },
      { text: "❌ Сорвался", callback_data: `c:${date}:0` },
    ]],
  };
}

// Days the participant still can (and should) report on.
function unreportedDays(stats: Stats, participantId: string): string[] {
  const p = stats.participants.find((x) => x.id === participantId);
  if (!p) return [];
  return p.days
    .filter((d) => d.status === "pending" && d.date !== stats.today)
    .map((d) => d.date);
}

function summary(stats: Stats): string {
  const lines = stats.participants.map((p) =>
    `${p.name} — ${p.habit.toLowerCase()}\n` +
    `  Стрик: ${days(p.currentStreak)}   Рекорд: ${days(p.bestStreak)}`
  );
  lines.push(`\nВместе: ${days(stats.pair.currentStreak)} подряд, ${days(stats.pair.totalDays)} всего`);
  lines.push(SITE_URL);
  return lines.join("\n");
}

async function handleCallback(query: {
  id: string;
  data?: string;
  message?: { chat: { id: number }; message_id: number };
  from: { id: number };
}): Promise<void> {
  const chatId = query.message?.chat.id ?? query.from.id;
  const participant = await findParticipant(chatId);

  if (!participant || !query.data?.startsWith("c:")) {
    await telegram("answerCallbackQuery", { callback_query_id: query.id, text: "Не узнаю тебя" });
    return;
  }

  const [, date, flag] = query.data.split(":");
  const success = flag === "1";

  await db("checkins?on_conflict=participant_id,date", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ participant_id: participant.id, date, success }),
  });

  const stats = await loadStats();
  const me = stats.participants.find((p) => p.id === participant.id)!;

  const verdict = success ? "✅ продержался" : "❌ сорвался";
  let text = `${formatDate(date)} — ${verdict}\n\n` +
    `Твой стрик: ${days(me.currentStreak)}\n` +
    `Вместе: ${days(stats.pair.currentStreak)}`;

  const remaining = unreportedDays(stats, participant.id);
  if (remaining.length > 0) {
    text += `\n\nОсталось отметить: ${remaining.map(formatDate).join(", ")} — /mark`;
  }

  await telegram("answerCallbackQuery", { callback_query_id: query.id });
  if (query.message) {
    await telegram("editMessageText", {
      chat_id: chatId,
      message_id: query.message.message_id,
      text,
    });
  }

  const others = (await allParticipants()).filter((p) => p.id !== participant.id);
  for (const other of others) {
    await telegram("sendMessage", {
      chat_id: other.telegram_chat_id,
      text: `${participant.name} отметил ${formatDate(date)}: ${verdict}\n` +
        `Вместе: ${days(stats.pair.currentStreak)}`,
    });
  }
}

async function handleMessage(message: {
  chat: { id: number };
  text?: string;
}): Promise<void> {
  const chatId = message.chat.id;
  const participant = await findParticipant(chatId);

  if (!participant) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: `Этот бот приватный.\nТвой chat_id: ${chatId}`,
    });
    return;
  }

  const command = (message.text ?? "").trim().split(/[\s@]/)[0].toLowerCase();
  const stats = await loadStats();

  if (command === "/start" || command === "/help") {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: `Привет, ${participant.name}.\n\n` +
        `Каждое утро в 10:00 я спрошу про вчерашний день. Отвечаешь одной кнопкой.\n\n` +
        `/status — где мы сейчас\n` +
        `/mark — отметить пропущенные дни\n\n` +
        SITE_URL,
    });
    return;
  }

  if (command === "/mark") {
    const pending = unreportedDays(stats, participant.id);
    if (pending.length === 0) {
      await telegram("sendMessage", { chat_id: chatId, text: "Всё отмечено." });
      return;
    }
    for (const date of pending) {
      await telegram("sendMessage", {
        chat_id: chatId,
        text: `${formatDate(date)} — ${participant.question}`,
        reply_markup: checkinKeyboard(date),
      });
    }
    return;
  }

  await telegram("sendMessage", { chat_id: chatId, text: summary(stats) });
}

Deno.serve(async (req: Request) => {
  if (req.headers.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  // Always answer 200 — a non-2xx makes Telegram retry the same update forever.
  try {
    const update = await req.json();
    if (update.callback_query) await handleCallback(update.callback_query);
    else if (update.message) await handleMessage(update.message);
  } catch (error) {
    console.error("update failed:", error);
  }

  return new Response("ok");
});
