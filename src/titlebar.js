'use strict';

const insetEl = document.getElementById('inset');
const titleButton = document.getElementById('title');
const markEl = document.getElementById('mark');
const faviconEl = document.getElementById('favicon');
const labelEl = document.getElementById('label');

// Which way the click goes is decided in the main process. The state push
// carries whether the bar is *shown*, and on a blank tab that is true even when
// the user never asked for it -- a renderer toggling on that value would always
// pick "hide" and never manage to pin.
titleButton.addEventListener('click', () => window.mullion.toggleNavigation());

function render(state) {
  // textContent, never innerHTML: the title comes from an untrusted page.
  labelEl.textContent = state.title || 'Mullion';
  insetEl.style.width = `${state.titleBarInset}px`;

  // The spinner takes the icon's place rather than sitting beside it, so the
  // title never shifts sideways between loading and loaded.
  markEl.classList.toggle('loading', Boolean(state.loading));
  if (state.favicon) {
    faviconEl.src = state.favicon;
    faviconEl.hidden = false;
  } else {
    faviconEl.removeAttribute('src');
    faviconEl.hidden = true;
  }
}

window.mullion.onState(render);
window.mullion.getState().then(render);
