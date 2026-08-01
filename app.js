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
  none: "до старта",
  future: "ещё впереди",
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

  // Always draw at least weeksShown weeks from the start, so the calendar has
  // its full shape from day one — the empty part ahead is the point.
  // Align the first column to a Monday so every grid column is one full week.
  const firstDataMonth = parseDate(startDate).getUTCMonth();
  const start = parseDate(startDate);
  start.setUTCDate(start.getUTCDate() - weekdayIndex(parseDate(startDate)));

  const plannedEnd = new Date(start);
  plannedEnd.setUTCDate(plannedEnd.getUTCDate() + CONFIG.weeksShown * 7 - 1);
  const todayDate = parseDate(today);
  const end = todayDate > plannedEnd ? todayDate : plannedEnd;

  const grid = element("div", "heatmap");
  const monthRow = element("div", "heatmap-months");

  let lastMonth = null;
  let lastLabelColumn = null;
  let column = 0;

  for (let cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const iso = toIso(cursor);
    const status = statusByDate.get(iso) ?? (cursor > todayDate ? "future" : "none");

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

function buildHabitCard(habit, today) {
  const card = element("section", "card");

  const header = element("header", "card-header");
  const titleRow = element("div", "card-title");
  titleRow.append(element("h2", "", habit.participantName));
  if (!habit.isShared) titleRow.append(element("span", "badge", "личная"));
  header.append(titleRow);
  header.append(element("p", "habit", habit.title));
  card.appendChild(header);

  const stats = element("div", "stats");
  stats.append(buildStat(habit.currentStreak, `${daysWord(habit.currentStreak)} подряд`, "primary"));
  stats.append(buildStat(habit.bestStreak, "рекорд"));
  stats.append(buildStat(habit.totalSuccess, "всего чисто"));
  stats.append(buildStat(habit.totalFail, "срывов"));
  card.appendChild(stats);

  const days = habit.days ?? [];
  const yesterday = shiftDate(today, -1);
  const yesterdayStatus = days.find((d) => d.date === yesterday)?.status;
  if (yesterdayStatus === "pending") {
    card.appendChild(element("p", "note", `${formatDate(yesterday)} ещё не отмечен`));
  } else if (habit.startDate > today) {
    card.appendChild(element("p", "note", `Старт ${formatDate(habit.startDate)}`));
  }

  card.appendChild(buildHeatmap(days, today, habit.startDate));
  return card;
}

function render(stats) {
  app.replaceChildren();

  const header = element("header", "page-header");
  header.append(element("h1", "", "derzhimsya"));
  header.append(element("p", "subtitle", `Сегодня ${formatDate(stats.today)}`));
  app.appendChild(header);

  const hero = element("section", "hero");
  hero.append(element("div", "hero-value", String(stats.pair.currentStreak)));
  hero.append(element("div", "hero-label", `${daysWord(stats.pair.currentStreak)} подряд без заказов еды у обоих`));

  const heroStats = element("div", "hero-stats");
  heroStats.append(element("span", "", `рекорд — ${stats.pair.bestStreak}`));
  heroStats.append(element("span", "", `всего чистых дней — ${stats.pair.totalDays}`));
  hero.appendChild(heroStats);
  app.appendChild(hero);

  const grid = element("div", "cards");
  stats.habits.forEach((h) => grid.appendChild(buildHabitCard(h, stats.today)));
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
