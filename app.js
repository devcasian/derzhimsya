const MONTHS_GENITIVE = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];
const MONTHS_SHORT = [
  "янв", "фев", "мар", "апр", "мая", "июн",
  "июл", "авг", "сен", "окт", "ноя", "дек",
];
const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

const STATUS_LABELS = {
  success: "продержался",
  fail: "сорвался",
  pending: "не отмечен",
  missed: "пропущен",
};

const app = document.getElementById("app");

function plural(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function daysWord(n) {
  return plural(n, "день", "дня", "дней");
}

function formatDate(isoDate) {
  const [, month, day] = isoDate.split("-");
  return `${Number(day)} ${MONTHS_GENITIVE[Number(month) - 1]}`;
}

function parseDate(isoDate) {
  return new Date(`${isoDate}T00:00:00Z`);
}

function toIso(date) {
  return date.toISOString().slice(0, 10);
}

function shiftDate(isoDate, delta) {
  const d = parseDate(isoDate);
  d.setUTCDate(d.getUTCDate() + delta);
  return toIso(d);
}

// Monday-based index: Mon = 0 … Sun = 6.
function weekdayIndex(date) {
  return (date.getUTCDay() + 6) % 7;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildHeatmap(days, today, startDate) {
  const statusByDate = new Map(days.map((d) => [d.date, d.status]));

  // The calendar grows from the week tracking began and stops growing once it
  // hits weeksShown, after which it becomes a sliding window.
  const end = parseDate(today);
  const windowStart = parseDate(today);
  windowStart.setUTCDate(windowStart.getUTCDate() - weekdayIndex(end) - (CONFIG.weeksShown - 1) * 7);

  // Align the first column to a Monday so every grid column is one full week.
  const trackingStart = parseDate(startDate);
  trackingStart.setUTCDate(trackingStart.getUTCDate() - weekdayIndex(parseDate(startDate)));

  const start = trackingStart > windowStart ? trackingStart : windowStart;
  const firstDataMonth = parseDate(startDate) > start
    ? parseDate(startDate).getUTCMonth()
    : start.getUTCMonth();

  const grid = element("div", "heatmap");
  const monthRow = element("div", "heatmap-months");

  let lastMonth = null;
  let lastLabelColumn = null;
  let column = 0;

  for (let cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const iso = toIso(cursor);
    const status = statusByDate.get(iso) ?? "none";

    const cell = element("div", `cell cell-${status}`);
    cell.title = `${formatDate(iso)} — ${STATUS_LABELS[status] ?? "нет данных"}`;
    grid.appendChild(cell);

    // One slot per column, emitted on the Monday that starts each week. A label
    // is wider than a column, so keep at least three columns between labels.
    if (weekdayIndex(cursor) === 0) {
      // The first column is usually partial; label it by the month the data
      // actually starts in, not by the Monday that pads it out.
      const month = column === 0 ? firstDataMonth : cursor.getUTCMonth();
      const isNewMonth = month !== lastMonth;
      const hasRoom = lastLabelColumn === null || column - lastLabelColumn >= 3;

      const label = element("span", "heatmap-month");
      // If there is no room, leave lastMonth alone so the label reappears a
      // column later instead of the month going unlabelled entirely.
      if (isNewMonth && hasRoom) {
        label.textContent = MONTHS_SHORT[month];
        lastLabelColumn = column;
        lastMonth = month;
      }

      monthRow.appendChild(label);
      column++;
    }
  }

  const wrapper = element("div", "heatmap-wrapper");
  const weekdayColumn = element("div", "heatmap-weekdays");
  WEEKDAYS.forEach((name, index) => {
    weekdayColumn.appendChild(element("span", "", index % 2 === 0 ? name : ""));
  });

  const scroll = element("div", "heatmap-scroll");
  const inner = element("div", "heatmap-inner");
  inner.append(monthRow, grid);
  scroll.appendChild(inner);
  wrapper.append(weekdayColumn, scroll);
  return wrapper;
}

function buildStat(value, label, modifier) {
  const stat = element("div", `stat${modifier ? ` stat-${modifier}` : ""}`);
  stat.append(element("div", "stat-value", String(value)));
  stat.append(element("div", "stat-label", label));
  return stat;
}

function buildParticipantCard(participant, today) {
  const card = element("section", "card");

  const header = element("header", "card-header");
  header.append(element("h2", "", participant.name));
  header.append(element("p", "habit", participant.habit));
  card.appendChild(header);

  const stats = element("div", "stats");
  stats.append(buildStat(participant.currentStreak, `${daysWord(participant.currentStreak)} подряд`, "primary"));
  stats.append(buildStat(participant.bestStreak, "рекорд"));
  stats.append(buildStat(participant.totalSuccess, "всего чисто"));
  stats.append(buildStat(participant.totalFail, "срывов"));
  card.appendChild(stats);

  const yesterday = shiftDate(today, -1);
  const yesterdayStatus = participant.days.find((d) => d.date === yesterday)?.status;
  if (yesterdayStatus === "pending") {
    card.appendChild(element("p", "note", `${formatDate(yesterday)} ещё не отмечен`));
  }

  card.appendChild(buildHeatmap(participant.days, today, participant.startDate));
  return card;
}

function render(stats) {
  app.replaceChildren();

  const header = element("header", "page-header");
  header.append(element("h1", "", "Держимся"));
  header.append(element("p", "subtitle", `Сегодня ${formatDate(stats.today)}`));
  app.appendChild(header);

  const hero = element("section", "hero");
  hero.append(element("div", "hero-value", String(stats.pair.currentStreak)));
  hero.append(element("div", "hero-label", `${daysWord(stats.pair.currentStreak)} подряд держимся оба`));

  const heroStats = element("div", "hero-stats");
  heroStats.append(element("span", "", `рекорд — ${stats.pair.bestStreak}`));
  heroStats.append(element("span", "", `всего чистых дней — ${stats.pair.totalDays}`));
  hero.appendChild(heroStats);
  app.appendChild(hero);

  const grid = element("div", "cards");
  stats.participants.forEach((p) => grid.appendChild(buildParticipantCard(p, stats.today)));
  app.appendChild(grid);
}

function renderError(message) {
  app.replaceChildren();
  const box = element("div", "error");
  box.append(element("h2", "", "Не удалось загрузить данные"));
  box.append(element("pre", "", message));
  app.appendChild(box);
}

async function load() {
  try {
    const response = await fetch(`${CONFIG.supabaseUrl}/rest/v1/rpc/stats`, {
      method: "POST",
      headers: {
        apikey: CONFIG.anonKey,
        Authorization: `Bearer ${CONFIG.anonKey}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    render(await response.json());
  } catch (error) {
    renderError(String(error));
  }
}

load();
setInterval(load, 5 * 60 * 1000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") load();
});
