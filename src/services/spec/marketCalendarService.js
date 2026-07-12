function isOpenSession(day) {
  if (!day) return true;
  return Number(day.is_open) === 1;
}

function isOpenBar(bar, calendarByDate) {
  return isOpenSession(calendarByDate.get(bar.bar_date));
}

function indexCalendar(days = []) {
  return new Map(days.map((day) => [day.session_date, day]));
}

module.exports = {
  indexCalendar,
  isOpenBar,
  isOpenSession,
};
