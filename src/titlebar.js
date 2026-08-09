'use strict';

const insetEl = document.getElementById('inset');
const titleButton = document.getElementById('title');
const markEl = document.getElementById('mark');
const faviconEl = document.getElementById('favicon');
const labelEl = document.getElementById('label');

let navigationVisible = false;

titleButton.addEventListener('click', () => {
  if (navigationVisible) window.mullion.hideNavigation();
  else window.mullion.showNavigation();
});

function render(state) {
  navigationVisible = state.navigationVisible;
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
