const FALLBACK_THUMBNAIL = 'fallback-map.svg';

const grid = document.getElementById('replayGrid');
const searchBox = document.getElementById('playerSearchBox');
const searchInput = document.getElementById('playerSearch');
const clearSearchButton = document.getElementById('clearPlayerSearch');
const suggestionPanel = document.getElementById('playerSuggestionPanel');
const suggestionList = document.getElementById('playerSuggestionList');
const matchModeToggle = document.getElementById('matchModeToggle');
const typeFilters = Array.from(document.querySelectorAll('.type-filter'));
const durationMinInput = document.getElementById('durationMin');
const durationMaxInput = document.getElementById('durationMax');
const durationMinLabel = document.getElementById('durationMinLabel');
const durationMaxLabel = document.getElementById('durationMaxLabel');
const durationRangeFill = document.getElementById('durationRangeFill');
const searchEmpty = document.getElementById('searchEmpty');
const refreshButton = document.getElementById('refreshReplays');
const template = document.getElementById('replayCardTemplate');
const renderedCards = [];
const DURATION_SLIDER_STEPS = 1000;
const DURATION_SLIDER_MIDPOINT_SECONDS = 5 * 60;
const SUGGESTION_LIMIT = 8;
let pendingSearchFrame = 0;
let hideUnmatched = true;
let durationBounds = { min: 0, max: 0 };
let suggestionItems = [];
let selectedSuggestionIndex = -1;
let loadingReplays = false;

function getInvoke() {
  return window.__TAURI__?.core?.invoke ?? null;
}

function normalizeSearchText(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function durationCurvePower() {
  const span = Math.max(0, durationBounds.max - durationBounds.min);
  const midpointOffset = DURATION_SLIDER_MIDPOINT_SECONDS - durationBounds.min;
  if (span === 0 || midpointOffset <= 0 || midpointOffset >= span) return 1;

  return Math.log(midpointOffset / span) / Math.log(0.5);
}

function durationPositionToSeconds(position) {
  const span = Math.max(0, durationBounds.max - durationBounds.min);
  if (span === 0) return durationBounds.min;

  const progress = clamp(Number(position) / DURATION_SLIDER_STEPS, 0, 1);
  return Math.round(durationBounds.min + span * progress ** durationCurvePower());
}

function secondsToDurationPosition(seconds) {
  const span = Math.max(0, durationBounds.max - durationBounds.min);
  if (span === 0) return 0;

  const offset = clamp(Number(seconds) - durationBounds.min, 0, span);
  const progress = (offset / span) ** (1 / durationCurvePower());
  return Math.round(progress * DURATION_SLIDER_STEPS);
}

function renderHighlightedText(element, text, query) {
  element.replaceChildren();
  if (!query) {
    element.textContent = text;
    return;
  }

  const lowerText = normalizeSearchText(text);
  let cursor = 0;
  let matchStart = lowerText.indexOf(query);

  while (matchStart !== -1) {
    if (matchStart > cursor) {
      element.append(document.createTextNode(text.slice(cursor, matchStart)));
    }

    const matchEnd = matchStart + query.length;
    const mark = document.createElement('mark');
    mark.textContent = text.slice(matchStart, matchEnd);
    element.append(mark);
    cursor = matchEnd;
    matchStart = lowerText.indexOf(query, cursor);
  }

  if (cursor < text.length) {
    element.append(document.createTextNode(text.slice(cursor)));
  }
}

function matchTypeLabel(playerCount) {
  if (playerCount === 2) return '1v1';
  if (playerCount === 3) return '3P FFA';
  if (playerCount === 4) return '4P FFA';
  return `${playerCount}P`;
}

function playerColorClass(player, fallbackIndex) {
  const teamIndex = Number.isInteger(player.teamIndex) ? player.teamIndex : fallbackIndex;
  return `player-${teamIndex + 1}`;
}

function selectedMatchTypes() {
  return new Set(typeFilters.filter((filter) => filter.checked).map((filter) => filter.value));
}

function currentDurationRange() {
  return {
    min: durationPositionToSeconds(durationMinInput.value),
    max: durationPositionToSeconds(durationMaxInput.value)
  };
}

function currentFilterState() {
  return {
    query: normalizeSearchText(searchInput.value),
    enabledTypes: selectedMatchTypes(),
    durationRange: currentDurationRange()
  };
}

function captureControlState() {
  return {
    query: searchInput.value,
    matchModeChecked: matchModeToggle.checked,
    selectedTypes: selectedMatchTypes(),
    durationRange: currentDurationRange()
  };
}

function applyControlState(state) {
  if (!state) return;

  searchInput.value = state.query;
  matchModeToggle.checked = state.matchModeChecked;
  hideUnmatched = !matchModeToggle.checked;
  typeFilters.forEach((filter) => {
    filter.checked = state.selectedTypes.has(filter.value);
  });

  const minValue = clamp(state.durationRange.min, durationBounds.min, durationBounds.max);
  const maxValue = clamp(state.durationRange.max, minValue, durationBounds.max);
  durationMinInput.value = String(secondsToDurationPosition(minValue));
  durationMaxInput.value = String(secondsToDurationPosition(maxValue));
  updateDurationLabels();
  updateClearButton();
}

function pluralize(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function cardMatchesNonSearchFilters(card, filterState) {
  return (
    filterState.enabledTypes.has(card.matchType) &&
    card.durationSeconds >= filterState.durationRange.min &&
    card.durationSeconds <= filterState.durationRange.max
  );
}

function cardMatchesFilters(card, filterState) {
  const matchesSearch = filterState.query === '' || card.searchText.includes(filterState.query);
  return matchesSearch && cardMatchesNonSearchFilters(card, filterState);
}

function setFiltersDisabled(disabled) {
  searchInput.disabled = disabled;
  matchModeToggle.disabled = disabled;
  typeFilters.forEach((filter) => {
    filter.disabled = disabled;
  });
  durationMinInput.disabled = disabled;
  durationMaxInput.disabled = disabled;
  if (disabled) {
    closeSuggestions();
  }
}

function resetSearchControl() {
  searchInput.value = '';
  selectedSuggestionIndex = -1;
  suggestionItems = [];
  updateClearButton();
  closeSuggestions();
  suggestionList.replaceChildren();
}

function updateClearButton() {
  clearSearchButton.hidden = searchInput.value.length === 0 || searchInput.disabled;
}

function setSuggestionsOpen(open) {
  const shouldOpen = open && !searchInput.disabled && suggestionItems.length > 0;
  suggestionPanel.hidden = !shouldOpen;
  searchBox.setAttribute('aria-expanded', String(shouldOpen));
  if (!shouldOpen) {
    selectedSuggestionIndex = -1;
    searchInput.removeAttribute('aria-activedescendant');
    updateActiveSuggestion();
  }
}

function closeSuggestions() {
  setSuggestionsOpen(false);
}

function suggestionMatchRank(name, query) {
  if (!query) return 0;
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.split(/\s+/).some((part) => part.startsWith(query))) return 2;
  return name.includes(query) ? 3 : Number.POSITIVE_INFINITY;
}

function buildSuggestionItems(filterState) {
  const playerStats = new Map();

  for (const card of renderedCards) {
    if (!cardMatchesNonSearchFilters(card, filterState)) {
      continue;
    }

    for (const [index, name] of card.names.entries()) {
      const key = card.normalizedNames[index];
      const rank = suggestionMatchRank(key, filterState.query);
      if (!Number.isFinite(rank)) {
        continue;
      }

      if (!playerStats.has(key)) {
        playerStats.set(key, {
          name,
          normalizedName: key,
          rank,
          replayCount: 0,
          winCount: 0,
          lossCount: 0,
          latestModified: 0,
          opponents: new Map()
        });
      }

      const stats = playerStats.get(key);
      stats.rank = Math.min(stats.rank, rank);
      stats.replayCount += 1;
      stats.winCount += card.winnerIndex === index ? 1 : 0;
      stats.lossCount += card.winnerIndex >= 0 && card.winnerIndex !== index ? 1 : 0;
      stats.latestModified = Math.max(stats.latestModified, card.modified);

      for (const [opponentIndex, opponentName] of card.names.entries()) {
        if (opponentIndex === index) {
          continue;
        }
        const opponentCount = stats.opponents.get(opponentName) ?? 0;
        stats.opponents.set(opponentName, opponentCount + 1);
      }
    }
  }

  return Array.from(playerStats.values())
    .map((item) => ({
      ...item,
      opponentNames: sortedOpponentNames(item.opponents)
    }))
    .sort((left, right) => {
      return (
        left.rank - right.rank ||
        right.replayCount - left.replayCount ||
        right.latestModified - left.latestModified ||
        left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
      );
    })
    .slice(0, SUGGESTION_LIMIT);
}

function sortedOpponentNames(opponents) {
  return Array.from(opponents.entries())
    .sort((left, right) => {
      return right[1] - left[1] || left[0].localeCompare(right[0], undefined, { sensitivity: 'base' });
    })
    .map(([name]) => name);
}

function refreshSuggestions(open = document.activeElement === searchInput) {
  const filterState = currentFilterState();
  suggestionItems = buildSuggestionItems(filterState);
  if (selectedSuggestionIndex >= suggestionItems.length) {
    selectedSuggestionIndex = suggestionItems.length - 1;
  }

  renderSuggestions(filterState.query);
  setSuggestionsOpen(open);
}

function renderSuggestions(query) {
  const fragment = document.createDocumentFragment();

  suggestionItems.forEach((item, index) => {
    const option = document.createElement('button');
    const primary = document.createElement('span');
    const name = document.createElement('span');
    const meta = document.createElement('span');
    const detail = document.createElement('span');

    option.id = `player-suggestion-${index}`;
    option.type = 'button';
    option.className = 'player-suggestion';
    option.dataset.index = String(index);
    option.setAttribute('role', 'option');

    primary.className = 'suggestion-primary';
    name.className = 'suggestion-name';
    meta.className = 'suggestion-meta';
    detail.className = 'suggestion-detail';

    renderHighlightedText(name, item.name, query);
    meta.textContent = `${pluralize(item.replayCount, 'replay')} - ${pluralize(item.winCount, 'win')} - ${pluralize(item.lossCount, 'loss')}`;
    detail.textContent = suggestionDetailText(item);

    primary.append(name, meta);
    option.append(primary, detail);
    fragment.append(option);
  });

  suggestionList.replaceChildren(fragment);
  updateActiveSuggestion();
}

function suggestionDetailText(item) {
  if (!item.opponentNames.length) {
    return 'No opponents yet';
  }

  const visibleOpponents = item.opponentNames.slice(0, 3);
  const remainingCount = item.opponentNames.length - visibleOpponents.length;
  if (remainingCount > 0) {
    return `vs ${visibleOpponents.join(', ')}, and ${remainingCount} more`;
  }

  return `vs ${visibleOpponents.join(', ')}`;
}

function updateActiveSuggestion() {
  Array.from(suggestionList.children).forEach((option, index) => {
    const selected = index === selectedSuggestionIndex;
    option.classList.toggle('is-active', selected);
    option.setAttribute('aria-selected', String(selected));
  });

  if (selectedSuggestionIndex < 0) {
    searchInput.removeAttribute('aria-activedescendant');
    return;
  }

  const activeOption = suggestionList.children[selectedSuggestionIndex];
  if (!activeOption) {
    searchInput.removeAttribute('aria-activedescendant');
    return;
  }

  searchInput.setAttribute('aria-activedescendant', activeOption.id);
  activeOption.scrollIntoView({ block: 'nearest' });
}

function moveSuggestionSelection(delta) {
  if (!suggestionItems.length) {
    refreshSuggestions(true);
  }
  if (!suggestionItems.length) {
    return;
  }

  if (suggestionPanel.hidden) {
    setSuggestionsOpen(true);
  }

  const startIndex = selectedSuggestionIndex < 0
    ? (delta > 0 ? -1 : 0)
    : selectedSuggestionIndex;
  selectedSuggestionIndex =
    (startIndex + delta + suggestionItems.length) % suggestionItems.length;
  updateActiveSuggestion();
}

function selectSuggestion(index) {
  const item = suggestionItems[index];
  if (!item) {
    return;
  }

  searchInput.value = item.name;
  selectedSuggestionIndex = -1;
  updateClearButton();
  closeSuggestions();
  scheduleSearch();
  searchInput.focus();
}

function clearSearch() {
  searchInput.value = '';
  selectedSuggestionIndex = -1;
  updateClearButton();
  refreshSuggestions(true);
  scheduleSearch();
  searchInput.focus();
}

function handleSearchInput() {
  selectedSuggestionIndex = -1;
  updateClearButton();
  refreshSuggestions(true);
  scheduleSearch();
}

function handleSearchFocus() {
  refreshSuggestions(true);
}

function handleSearchKeydown(event) {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveSuggestionSelection(1);
    return;
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveSuggestionSelection(-1);
    return;
  }

  if (event.key === 'Enter' && selectedSuggestionIndex >= 0 && !suggestionPanel.hidden) {
    event.preventDefault();
    selectSuggestion(selectedSuggestionIndex);
    return;
  }

  if (event.key === 'Escape') {
    closeSuggestions();
  }
}

function handleSuggestionPointerDown(event) {
  const option = event.target.closest('.player-suggestion');
  if (!option) {
    return;
  }

  event.preventDefault();
  selectSuggestion(Number(option.dataset.index));
}

function handleOutsidePointerDown(event) {
  if (!searchBox.contains(event.target)) {
    closeSuggestions();
  }
}

function setupDurationFilter(replays) {
  const durations = replays.map((replay) => Number(replay.durationSeconds) || 0);
  durationBounds.min = Math.min(...durations);
  durationBounds.max = Math.max(...durations);

  for (const input of [durationMinInput, durationMaxInput]) {
    input.min = '0';
    input.max = String(DURATION_SLIDER_STEPS);
  }

  durationMinInput.value = String(secondsToDurationPosition(durationBounds.min));
  durationMaxInput.value = String(secondsToDurationPosition(durationBounds.max));
  updateDurationLabels();
}

function updateDurationLabels() {
  let minPosition = Number(durationMinInput.value) || 0;
  let maxPosition = Number(durationMaxInput.value) || DURATION_SLIDER_STEPS;

  if (minPosition > maxPosition) {
    const active = document.activeElement;
    if (active === durationMinInput) {
      maxPosition = minPosition;
      durationMaxInput.value = String(maxPosition);
    } else {
      minPosition = maxPosition;
      durationMinInput.value = String(minPosition);
    }
  }

  const minValue = durationPositionToSeconds(minPosition);
  const maxValue = durationPositionToSeconds(maxPosition);
  durationMinLabel.textContent = formatDuration(minValue);
  durationMaxLabel.textContent = formatDuration(maxValue);

  const left = (minPosition / DURATION_SLIDER_STEPS) * 100;
  const right = ((DURATION_SLIDER_STEPS - maxPosition) / DURATION_SLIDER_STEPS) * 100;
  durationRangeFill.style.left = `${left}%`;
  durationRangeFill.style.right = `${right}%`;
}

function renderState(className, message) {
  grid.className = `replay-grid ${className}`;
  grid.innerHTML = '';
  renderedCards.length = 0;
  resetSearchControl();
  setFiltersDisabled(true);
  searchEmpty.hidden = true;
  const state = document.createElement('div');
  state.className = 'state-message';
  state.textContent = message;
  grid.append(state);
}

function renderReplays(replays, controlState = null) {
  grid.className = 'replay-grid';
  grid.innerHTML = '';
  renderedCards.length = 0;
  resetSearchControl();
  setFiltersDisabled(!replays.length);
  searchEmpty.hidden = true;

  if (!replays.length) {
    renderState('is-empty', 'No replays found.');
    return;
  }

  setupDurationFilter(replays);

  const fragment = document.createDocumentFragment();
  for (const replay of replays) {
    const card = template.content.firstElementChild.cloneNode(true);
    const image = card.querySelector('.replay-thumb');
    const players = card.querySelector('.players');
    const matchType = card.querySelector('.match-type');
    const length = card.querySelector('.length');

    image.src = replay.thumbnailDataUrl || FALLBACK_THUMBNAIL;
    image.onerror = () => {
      image.onerror = null;
      image.src = FALLBACK_THUMBNAIL;
    };

    const winnerIndex = replay.players.findIndex((player) => player.winner);
    const winner = winnerIndex >= 0 ? replay.players[winnerIndex] : null;
    const matchup = document.createElement('div');
    const winnerLine = winner ? document.createElement('div') : null;
    const winnerName = winner ? document.createElement('span') : null;
    const nameElements = replay.players.map((player, index) => {
      const name = document.createElement('span');
      name.className = `player-name ${playerColorClass(player, index)}`;
      name.textContent = player.name;
      return name;
    });

    matchup.className = `matchup player-count-${replay.players.length}`;
    if (winnerLine && winnerName) {
      winnerLine.className = 'winner-line';
      winnerName.className = `winner-name ${playerColorClass(winner, winnerIndex)}`;
      winnerName.textContent = winner.name;
    }
    nameElements.forEach((element, index) => {
      if (index > 0) {
        const separator = document.createElement('span');
        separator.className = 'matchup-separator';
        separator.textContent = ' vs ';
        matchup.append(separator);
      }
      matchup.append(element);
    });
    if (winnerLine && winnerName) {
      winnerLine.append(document.createTextNode('winner: '), winnerName);
      players.replaceChildren(matchup, winnerLine);
    } else {
      players.replaceChildren(matchup);
    }

    matchType.textContent = matchTypeLabel(replay.players.length);
    length.textContent = replay.length;
    card.setAttribute('aria-label', replay.players.map((player) => player.name).join(' versus '));
    renderedCards.push({
      element: card,
      searchText: normalizeSearchText(replay.players.map((player) => player.name).join(' ')),
      matchType: matchType.textContent,
      durationSeconds: Number(replay.durationSeconds) || 0,
      modified: Number(replay.modified) || 0,
      names: replay.players.map((player) => player.name),
      normalizedNames: replay.players.map((player) => normalizeSearchText(player.name)),
      winnerIndex,
      winnerName: winner?.name ?? '',
      nameElements,
      winnerNameElement: winnerName,
      visible: true
    });
    fragment.append(card);
  }

  grid.append(fragment);
  applyControlState(controlState);
  refreshSuggestions(document.activeElement === searchInput);
  scheduleSearch();
}

function applySearch() {
  pendingSearchFrame = 0;
  const filterState = currentFilterState();
  let visibleCount = 0;

  for (const card of renderedCards) {
    const visible = cardMatchesFilters(card, filterState);
    card.nameElements.forEach((element, index) => {
      renderHighlightedText(element, card.names[index], filterState.query);
    });
    if (card.winnerNameElement) {
      renderHighlightedText(card.winnerNameElement, card.winnerName, filterState.query);
    }

    card.element.hidden = hideUnmatched && !visible;
    card.element.classList.toggle('is-dimmed', !hideUnmatched && !visible);
    card.visible = visible;
    if (visible) visibleCount += 1;
  }

  searchEmpty.hidden = !hideUnmatched || visibleCount > 0;
}

function scheduleSearch() {
  if (pendingSearchFrame) return;
  pendingSearchFrame = window.requestAnimationFrame(applySearch);
}

function toggleMatchMode() {
  hideUnmatched = !matchModeToggle.checked;
  scheduleSearch();
}

function filterByDuration() {
  updateDurationLabels();
  refreshSuggestions(document.activeElement === searchInput);
  scheduleSearch();
}

function setRefreshButtonLoading(loading) {
  loadingReplays = loading;
  refreshButton.disabled = loading;
  refreshButton.classList.toggle('is-loading', loading);
  refreshButton.setAttribute('aria-busy', String(loading));
}

function refreshReplays() {
  if (loadingReplays) return;
  loadReplays({ preserveControls: true, showLoading: false });
}

function focusSearch(event) {
  const wantsSearch = (event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'f';
  if (!wantsSearch) return;

  event.preventDefault();
  searchInput.focus();
  searchInput.select();
}

async function loadReplays({ preserveControls = false, showLoading = true } = {}) {
  const invoke = getInvoke();
  if (!invoke) {
    renderState('is-error', 'This view must run inside Tauri.');
    refreshButton.disabled = true;
    return;
  }

  const controlState = preserveControls ? captureControlState() : null;
  setRefreshButtonLoading(true);
  if (showLoading) {
    renderState('is-loading', 'Loading replays...');
  }

  try {
    const replays = await invoke('list_replays');
    renderReplays(replays, controlState);
  } catch (error) {
    renderState('is-error', String(error || 'Could not load replays.'));
  } finally {
    setRefreshButtonLoading(false);
  }
}

document.addEventListener('keydown', focusSearch);
document.addEventListener('pointerdown', handleOutsidePointerDown);
searchInput.addEventListener('input', handleSearchInput);
searchInput.addEventListener('focus', handleSearchFocus);
searchInput.addEventListener('keydown', handleSearchKeydown);
clearSearchButton.addEventListener('pointerdown', (event) => {
  event.preventDefault();
});
clearSearchButton.addEventListener('click', clearSearch);
suggestionList.addEventListener('pointerdown', handleSuggestionPointerDown);
matchModeToggle.addEventListener('click', toggleMatchMode);
typeFilters.forEach((filter) => {
  filter.addEventListener('change', () => {
    refreshSuggestions(document.activeElement === searchInput);
    scheduleSearch();
  });
});
durationMinInput.addEventListener('input', filterByDuration);
durationMaxInput.addEventListener('input', filterByDuration);
refreshButton.addEventListener('click', refreshReplays);
loadReplays();
