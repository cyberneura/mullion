'use strict';

const tabBar = document.getElementById('tab-bar');
const tabsEl = document.getElementById('tabs');
const toolbar = document.getElementById('toolbar');
const urlInput = document.getElementById('url');
const backButton = document.getElementById('back');
const forwardButton = document.getElementById('forward');
const reloadButton = document.getElementById('reload');
const externalButton = document.getElementById('external');
const collapseButton = document.getElementById('collapse');
const newTabButton = document.getElementById('new-tab');
const closeIcon = document.getElementById('close-icon');

// While the user is editing the address bar, incoming state must not overwrite
// what they are typing -- state arrives on every navigation event.
let urlIsBeingEdited = false;

urlInput.addEventListener('focus', () => {
  urlIsBeingEdited = true;
  urlInput.select();
});

urlInput.addEventListener('blur', () => {
  urlIsBeingEdited = false;
});

urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    window.mullion.navigate(urlInput.value.trim());
    urlInput.blur();
  }
});

backButton.addEventListener('click', () => window.mullion.go('back'));
forwardButton.addEventListener('click', () => window.mullion.go('forward'));
reloadButton.addEventListener('click', () => window.mullion.go('reload'));
externalButton.addEventListener('click', () => window.mullion.openExternal());
collapseButton.addEventListener('click', () => window.mullion.hideNavigation());
newTabButton.addEventListener('click', () => window.mullion.newTab());

// Tab elements are rebuilt from scratch on each state update. The list is at
// most a handful of nodes, so diffing would cost more than it saves.
function renderTabs(state) {
  tabsEl.replaceChildren();
  for (const tab of state.tabs) {
    const element = document.createElement('div');
    element.className = tab.id === state.activeTabId ? 'tab active' : 'tab';
    element.addEventListener('click', () => window.mullion.selectTab(tab.id));

    const title = document.createElement('span');
    title.className = 'tab-title';
    // textContent, never innerHTML: the title comes from an untrusted page.
    title.textContent = tab.title || 'Untitled';
    title.title = tab.url || '';
    element.append(title);

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.type = 'button';
    close.title = 'Close tab';
    close.setAttribute('aria-label', 'Close tab');
    close.append(closeIcon.content.cloneNode(true));
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      window.mullion.closeTab(tab.id);
    });
    element.append(close);

    tabsEl.append(element);
  }
}

function render(state) {
  tabBar.hidden = !state.tabBarVisible;
  toolbar.hidden = !state.navigationVisible;
  renderTabs(state);

  const active = state.tabs.find((tab) => tab.id === state.activeTabId);
  if (!urlIsBeingEdited) urlInput.value = active ? active.url || '' : '';
  backButton.disabled = !(active && active.canGoBack);
  forwardButton.disabled = !(active && active.canGoForward);
}

window.mullion.onState(render);
window.mullion.onFocusUrl(() => {
  urlInput.focus();
  urlInput.select();
});

window.mullion.getState().then(render);
