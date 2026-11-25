// The check-in message: one per participant per day, a row of buttons per
// habit. Built from stats() every time, so a tap re-renders it in place.

import { SITE_URL, telegram } from "./api.ts";

export type Gender = "m" | "f";
export type DayStatus = "success" | "fail" | "pending" | "missed";

export interface Participant {
  id: string;
  name: string;
  gender: Gender;
  telegram_chat_id: number;
}

export interface HabitState {
  id: string;
  participantId: string;
  title: string;
  emoji: string;
  isShared: boolean;
  currentStreak: number;
  days: Array<{ date: string; status: DayStatus }>;
}

export interface Stats {
  today: string;
  graceDays: number;
  habits: HabitState[];
  pair: { currentStreak: number };
}

const MONTHS_GENITIVE = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

export function formatDate(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  return `${Number(day)} ${MONTHS_GENITIVE[Number(month) - 1]}`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function days(n: number): string {
  return `${n} ${plural(n, "день", "дня", "дней")}`;
}

function shiftDate(isoDate: string, delta: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function byGender(gender: Gender, male: string, female: string): string {
  return gender === "f" ? female : male;
}

export function verdict(success: boolean, gender: Gender): string {
  return success
    ? `✅ ${byGender(gender, "продержался", "продержалась")}`
    : `❌ ${byGender(gender, "сорвался", "сорвалась")}`;
}

export function statusOn(habit: HabitState, date: string): DayStatus | undefined {
  return habit.days.find((d) => d.date === date)?.status;
}

// Same window as the 'pending' rule in stats(). Today is excluded: it is not over yet.
export function isOpen(stats: Stats, date: string): boolean {
  return date < stats.today && date >= shiftDate(stats.today, -stats.graceDays);
}

function statusText(status: DayStatus, gender: Gender): string {
  switch (status) {
    case "success": return verdict(true, gender);
    case "fail": return verdict(false, gender);
    case "missed": return "пропущен";
    case "pending": return "?";
  }
}

export function renderCheckin(
  stats: Stats,
  participant: Participant,
  date: string,
  heading: string,
) {
  const habits = stats.habits.filter(
    (h) => h.participantId === participant.id && statusOn(h, date),
  );
  const gender = participant.gender;

  const lines = habits.map((h) => `${h.emoji} ${h.title} — ${statusText(statusOn(h, date)!, gender)}`);
  const streaks = habits.map((h) => `${h.emoji} ${h.currentStreak}`).join(" · ");
  const pairLine = habits.some((h) => h.isShared)
    ? `\nВместе: ${days(stats.pair.currentStreak)} подряд`
    : "";

  const button = (habit: HabitState, success: boolean) => {
    const chosen = statusOn(habit, date) === (success ? "success" : "fail");
    const label = success
      ? `✅ ${byGender(gender, "Держался", "Держалась")}`
      : `❌ ${byGender(gender, "Сорвался", "Сорвалась")}`;
    return {
      text: `${habit.emoji} ${label}`,
      callback_data: `c:${habit.id}:${date}:${success ? 1 : 0}`,
      ...(chosen ? { style: success ? "success" : "danger" } : {}),
    };
  };

  // A closed day keeps its summary but loses the buttons.
  const keyboard = isOpen(stats, date)
    ? habits.map((h) => [button(h, true), button(h, false)])
    : [];

  return {
    text: `${heading}\n\n${lines.join("\n")}\n\nСтрик: ${streaks}${pairLine}\n\n${SITE_URL}`,
    reply_markup: { inline_keyboard: keyboard },
  };
}

function heading(stats: Stats, participant: Participant, date: string, isMorning: boolean): string {
  const when = formatDate(date);
  if (date !== shiftDate(stats.today, -1)) return `${participant.name}, день ${when} остался неотмеченным.`;
  return isMorning
    ? `Доброе утро, ${participant.name}. Как прошло ${when}?`
    : `${participant.name}, как прошло ${when}?`;
}

// Oldest first: that day ages out of the grace window soonest.
export async function sendCheckins(
  stats: Stats,
  participant: Participant,
  isMorning: boolean,
): Promise<string[]> {
  const dates = [...new Set(
    stats.habits
      .filter((h) => h.participantId === participant.id)
      .flatMap((h) => h.days)
      .filter((d) => d.status === "pending" && isOpen(stats, d.date))
      .map((d) => d.date),
  )].sort();

  for (const date of dates) {
    await telegram("sendMessage", {
      chat_id: participant.telegram_chat_id,
      ...renderCheckin(stats, participant, date, heading(stats, participant, date, isMorning)),
    });
  }

  return dates;
}
