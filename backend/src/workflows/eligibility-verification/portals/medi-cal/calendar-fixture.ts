// Read-only inputs ensure browser tests cannot pass by typing dates.
export function mediCalCalendarFixture(longDate = false) {
  return `
    <input id="issue-date" readonly onclick="openCalendar(this)">
    <input id="birth-date" readonly onclick="openCalendar(this)">
    <input id="service-date" readonly onclick="openCalendar(this)">
    <div id="calendar" hidden>
      <label>Month*<select id="month" onchange="renderDays()">${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((name, index) => `<option value="${index}">${name}</option>`).join('')}</select></label>
      <label>Year*<select id="year" onchange="renderDays()">${Array.from({ length: 150 }, (_, index) => `<option>${1900 + index}</option>`).join('')}</select></label>
      <div id="days"></div><button onclick="document.querySelector('#calendar').hidden=true">Cancel</button>
      <button aria-label="" onclick="confirmCalendar()"><div>OK</div></button>
    </div>
    <script>
      let activeInput, selectedDay;
      const month = document.querySelector('#month'), year = document.querySelector('#year');
      function openCalendar(input) {
        activeInput = input; selectedDay = null;
        year.value = '2026'; month.value = '8';
        renderDays(); document.querySelector('#calendar').hidden = false;
      }
      function renderDays() {
        selectedDay = null;
        const days = document.querySelector('#days'); days.innerHTML = '';
        const count = new Date(Number(year.value), Number(month.value) + 1, 0).getDate();
        for (let day = 1; day <= count; day++) {
          const button = document.createElement('button');
          button.setAttribute('aria-label', '');
          button.className = 'DatePicker-module__day__1lrYG';
          const cell = document.createElement('div');
          cell.id = 'day-' + Math.floor(day / 7) + '-' + (day % 7) + '-' + activeInput.id;
          cell.className = 'DatePicker-module__nonSelectedDay__1ltMu';
          cell.textContent = String(day); button.appendChild(cell);
          button.onclick = () => { selectedDay = day; }; days.appendChild(button);
        }
      }
      function confirmCalendar() {
        if (!selectedDay) throw new Error('Select a day before OK');
        activeInput.value = String(Number(month.value) + 1).padStart(2, '0') + '/' + String(selectedDay).padStart(2, '0') + '/' + year.value;
        if (${longDate}) activeInput.value = month.options[month.selectedIndex].text + ' ' + selectedDay + ', ' + year.value;
        activeInput.dataset.confirmed = 'true';
        document.querySelector('#calendar').hidden = true;
      }
    </script>
  `;
}
