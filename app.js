(() => {
  "use strict";

  const STORAGE_KEY = "isaac-progress-v1";
  const data = window.ISAAC_ACHIEVEMENTS_DATA;
  if (!data || !Array.isArray(data.achievements)) {
    document.body.innerHTML = "<p style='padding:40px;color:white'>Не удалось загрузить базу достижений.</p>";
    return;
  }

  const achievements = data.achievements;
  const byId = new Map(achievements.map(item => [item.id, item]));
  const state = {
    unlocked: null,
    saveMeta: null,
    status: "all",
    query: "",
    edition: "all",
    type: "all",
    sort: "id-asc"
  };

  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const elements = {
    grid: $("#achievement-grid"),
    empty: $("#empty-state"),
    results: $("#results-label"),
    search: $("#search-input"),
    edition: $("#edition-filter"),
    type: $("#type-filter"),
    sort: $("#sort-filter"),
    fileInput: $("#save-file"),
    guide: $("#save-guide"),
    detailModal: $("#achievement-modal"),
    detail: $("#achievement-detail"),
    toast: $("#toast"),
    editionStats: $("#edition-stats"),
    progressPercent: $("#progress-percent"),
    progressRing: $("#progress-ring"),
    ringValue: $("#ring-value"),
    progressFill: $("#progress-bar-fill"),
    unlockedCount: $("#unlocked-count"),
    lockedCount: $("#locked-count"),
    saveState: $("#save-state"),
    forget: $("#forget-progress"),
    saveNotice: $("#active-save-notice"),
    saveCopy: $("#active-save-copy")
  };

  function escapeText(value) {
    return String(value ?? "");
  }

  function showToast(title, text = "", error = false) {
    elements.toast.className = "toast" + (error ? " is-error" : "");
    elements.toast.innerHTML = "";
    const strong = document.createElement("strong");
    strong.textContent = title;
    elements.toast.append(strong);
    if (text) {
      const span = document.createElement("span");
      span.textContent = text;
      elements.toast.append(span);
    }
    elements.toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { elements.toast.hidden = true; }, 4200);
  }

  function openModal(modal) {
    modal.hidden = false;
    document.body.classList.add("modal-open");
  }

  function closeModal(modal) {
    modal.hidden = true;
    if (elements.guide.hidden && elements.detailModal.hidden) document.body.classList.remove("modal-open");
  }

  function saveProgress() {
    if (!state.unlocked || !state.saveMeta) return;
    const payload = {
      unlocked: [...state.unlocked].sort((a,b) => a-b),
      meta: state.saveMeta
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }

  function restoreProgress() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.unlocked)) return;
      state.unlocked = new Set(parsed.unlocked.filter(id => Number.isInteger(id) && id >= 1 && id <= 641));
      state.saveMeta = parsed.meta || { fileName: "Сохранённый прогресс" };
    } catch (error) {
      console.warn("Не удалось восстановить прогресс", error);
    }
  }

  function uint32LE(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  }

  function parseSave(buffer, fileName) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 700) throw new Error("Файл слишком маленький и не похож на persistentgamedata.");

    const header = new TextDecoder("ascii").decode(bytes.slice(0, 16)).replace(/\0/g, "").trim();
    if (!header.startsWith("ISAACNGSAVE")) {
      throw new Error("Неизвестный заголовок сохранения. Выберите persistentgamedata, а не gamestate.");
    }

    const entryLens = [1, 4, 4, 1, 1, 1, 1, 4, 4, 1, 546];
    let offset = 0x14;
    const sectionOffsets = [];
    const sectionCounts = [];

    for (const entryLength of entryLens) {
      if (offset + 12 > bytes.length) throw new Error("Повреждена таблица разделов сохранения.");
      const sectionId = uint32LE(bytes, offset);
      const sectionSize = uint32LE(bytes, offset + 4);
      const entryCount = uint32LE(bytes, offset + 8);
      offset += 12;
      sectionOffsets.push(offset);
      sectionCounts.push(entryCount);
      const jump = entryCount * entryLength;
      if (jump < 0 || offset + jump > bytes.length + 600) throw new Error("Некорректный размер раздела сохранения.");
      offset += jump;
      void sectionId; void sectionSize;
    }

    const achievementBase = sectionOffsets[0];
    const countIncludingMarker = sectionCounts[0];
    const availableCount = Math.max(0, Math.min(641, countIncludingMarker - 1));
    if (availableCount < 100) throw new Error("В файле не найден нормальный раздел достижений.");

    const unlocked = new Set();
    for (let index = 0; index < availableCount; index++) {
      const byteOffset = achievementBase + 1 + index;
      if (byteOffset >= bytes.length) break;
      if (bytes[byteOffset] !== 0) unlocked.add(index + 1);
    }

    return {
      unlocked,
      meta: {
        fileName,
        header,
        parsedAt: new Date().toISOString(),
        achievementSlots: availableCount,
        fileSize: bytes.length
      }
    };
  }

  async function handleFile(file) {
    if (!file) return;
    if (!/persistentgamedata/i.test(file.name)) {
      const proceed = confirm("Название файла не содержит persistentgamedata. Всё равно попробовать прочитать его?");
      if (!proceed) return;
    }
    try {
      const result = parseSave(await file.arrayBuffer(), file.name);
      state.unlocked = result.unlocked;
      state.saveMeta = result.meta;
      saveProgress();
      updateProgressUI();
      render();
      closeModal(elements.guide);
      showToast("Сохранение успешно прочитано", `Открыто достижений: ${state.unlocked.size} из 641.`);
      document.querySelector("#catalog-title").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      console.error(error);
      showToast("Не удалось прочитать файл", error.message || "Проверьте, что выбран persistentgamedata*.dat.", true);
    } finally {
      elements.fileInput.value = "";
    }
  }

  function isUnlocked(id) {
    return state.unlocked ? state.unlocked.has(id) : null;
  }

  function populateTypes() {
    const types = [...new Set(achievements.map(item => item.type).filter(Boolean))]
      .sort((a,b) => a.localeCompare(b, "ru"));
    for (const type of types) {
      const option = document.createElement("option");
      option.value = type;
      option.textContent = type;
      elements.type.append(option);
    }
  }

  function renderEditionStats() {
    const editions = ["Rebirth", "Afterbirth", "Afterbirth+", "Repentance"];
    elements.editionStats.innerHTML = "";
    for (const edition of editions) {
      const list = achievements.filter(item => item.edition === edition);
      const unlocked = state.unlocked ? list.filter(item => state.unlocked.has(item.id)).length : null;
      const percent = unlocked === null ? 0 : Math.round(unlocked / list.length * 100);
      const card = document.createElement("article");
      card.className = "edition-stat";
      card.innerHTML = `<div class="edition-stat__top"><strong>${edition}</strong><span>${unlocked === null ? list.length + " достижений" : unlocked + " / " + list.length}</span></div><div class="mini-bar"><i style="width:${percent}%"></i></div>`;
      elements.editionStats.append(card);
    }
  }

  function updateProgressUI() {
    renderEditionStats();
    if (!state.unlocked) {
      elements.progressPercent.textContent = "—";
      elements.progressRing.style.setProperty("--progress", 0);
      elements.ringValue.textContent = "0%";
      elements.progressFill.style.width = "0%";
      elements.unlockedCount.textContent = "—";
      elements.lockedCount.textContent = "—";
      elements.saveState.classList.remove("is-loaded");
      elements.saveState.innerHTML = `<span class="save-state__icon">?</span><div><strong>Сохранение не загружено</strong><small>Пока показан полный справочник</small></div>`;
      elements.forget.hidden = true;
      elements.saveNotice.hidden = true;
      document.querySelector("#header-load-button").textContent = "Загрузить сохранение";
      return;
    }

    const unlocked = state.unlocked.size;
    const locked = 641 - unlocked;
    const percentRaw = unlocked / 641 * 100;
    const percent = Math.round(percentRaw * 10) / 10;
    elements.progressPercent.textContent = `${unlocked} / 641`;
    elements.progressRing.style.setProperty("--progress", percentRaw.toFixed(2));
    elements.ringValue.textContent = `${Math.round(percentRaw)}%`;
    elements.progressFill.style.width = `${percentRaw}%`;
    elements.unlockedCount.textContent = unlocked;
    elements.lockedCount.textContent = locked;
    elements.saveState.classList.add("is-loaded");
    elements.saveState.innerHTML = `<span class="save-state__icon">✓</span><div><strong>${percent}% достижений</strong><small>${escapeText(state.saveMeta?.fileName || "Сохранение")}</small></div>`;
    elements.forget.hidden = false;
    elements.saveNotice.hidden = false;
    const parsedDate = state.saveMeta?.parsedAt ? new Date(state.saveMeta.parsedAt).toLocaleString("ru-RU") : "";
    elements.saveCopy.textContent = `${state.saveMeta?.fileName || "Сохранение"}${parsedDate ? " · " + parsedDate : ""}`;
    document.querySelector("#header-load-button").textContent = "Обновить сохранение";
  }

  function filteredAchievements() {
    const query = state.query.trim().toLocaleLowerCase("ru");
    let list = achievements.filter(item => {
      const status = isUnlocked(item.id);
      if (state.status === "unlocked" && status !== true) return false;
      if (state.status === "locked" && status !== false) return false;
      if (state.edition !== "all" && item.edition !== state.edition) return false;
      if (state.type !== "all" && item.type !== state.type) return false;
      if (query) {
        const haystack = [item.id, item.name.ru, item.name.en, item.condition.text, item.type, item.edition].join(" ").toLocaleLowerCase("ru");
        if (!haystack.includes(query)) return false;
      }
      return true;
    });

    list.sort((a,b) => {
      if (state.sort === "id-desc") return b.id - a.id;
      if (state.sort === "name") return a.name.ru.localeCompare(b.name.ru, "ru");
      if (state.sort === "locked-first") {
        const av = isUnlocked(a.id) === false ? 0 : 1;
        const bv = isUnlocked(b.id) === false ? 0 : 1;
        return av - bv || a.id - b.id;
      }
      return a.id - b.id;
    });
    return list;
  }

  function createCard(item) {
    const status = isUnlocked(item.id);
    const card = document.createElement("button");
    card.type = "button";
    card.className = "achievement-card" + (status === false ? " is-locked" : "") + (status === true ? " is-unlocked" : "");
    card.dataset.id = item.id;
    card.setAttribute("aria-label", `Достижение ${item.id}: ${item.name.ru}`);

    const number = document.createElement("span");
    number.className = "achievement-number";
    number.textContent = `#${item.id}`;

    const icon = document.createElement("span");
    icon.className = "achievement-icon";
    const img = document.createElement("img");
    img.src = item.icon.url;
    img.alt = item.icon.alt || item.name.ru;
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    icon.append(img);

    const copy = document.createElement("span");
    copy.className = "achievement-copy";
    const h3 = document.createElement("h3");
    h3.textContent = item.name.ru;
    const en = document.createElement("span");
    en.className = "english-name";
    en.textContent = item.name.en;
    const tags = document.createElement("span");
    tags.className = "card-tags";
    const edition = document.createElement("span");
    edition.className = "card-tag edition";
    edition.textContent = item.edition;
    const type = document.createElement("span");
    type.className = "card-tag";
    type.textContent = item.type;
    tags.append(edition, type);
    copy.append(h3, en, tags);

    const condition = document.createElement("p");
    condition.className = "card-condition";
    condition.textContent = item.condition.text;

    const pill = document.createElement("span");
    pill.className = "status-pill";
    pill.textContent = status === true ? "Открыто" : status === false ? "Закрыто" : "Статус неизвестен";
    const hint = document.createElement("span");
    hint.className = "card-open-hint";
    hint.textContent = "Подробнее →";

    card.append(number, icon, copy, condition, pill, hint);
    card.addEventListener("click", () => openAchievement(item.id));
    return card;
  }

  function render() {
    const list = filteredAchievements();
    elements.grid.innerHTML = "";
    const fragment = document.createDocumentFragment();
    for (const item of list) fragment.append(createCard(item));
    elements.grid.append(fragment);
    elements.results.textContent = `Показано ${list.length} из 641`;
    elements.empty.hidden = list.length !== 0;
    elements.grid.hidden = list.length === 0;
  }

  function renderRichCondition(container, parts, fallbackText) {
    container.innerHTML = "";
    if (!Array.isArray(parts) || parts.length === 0) {
      container.textContent = fallbackText;
      return;
    }
    for (const part of parts) {
      if (part.kind === "text") {
        container.append(document.createTextNode(part.text || ""));
      } else if (part.kind === "link") {
        const link = document.createElement("a");
        link.href = part.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = part.text || part.url;
        container.append(link);
      } else if (part.kind === "image") {
        const image = document.createElement("img");
        image.src = part.url;
        image.alt = part.alt || "";
        image.title = part.alt || part.title || "";
        image.loading = "lazy";
        image.referrerPolicy = "no-referrer";
        if (part.linkUrl) {
          const link = document.createElement("a");
          link.href = part.linkUrl;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.append(image);
          container.append(link);
        } else {
          container.append(image);
        }
      }
    }
  }

  function openAchievement(id) {
    const item = byId.get(id);
    if (!item) return;
    const status = isUnlocked(id);
    elements.detail.innerHTML = "";

    const head = document.createElement("div");
    head.className = "detail-head";
    const icon = document.createElement("div");
    icon.className = "detail-icon";
    const img = document.createElement("img");
    img.src = item.icon.url;
    img.alt = item.icon.alt || item.name.ru;
    img.referrerPolicy = "no-referrer";
    icon.append(img);

    const headCopy = document.createElement("div");
    const idLine = document.createElement("span");
    idLine.className = "detail-id";
    idLine.textContent = `ДОСТИЖЕНИЕ #${item.id}`;
    const title = document.createElement("h2");
    title.id = "detail-title";
    title.textContent = item.name.ru;
    const english = document.createElement("div");
    english.className = "detail-en";
    english.textContent = item.name.en;
    const tags = document.createElement("div");
    tags.className = "detail-tags";
    for (const text of [item.edition, item.type]) {
      const tag = document.createElement("span");
      tag.className = "detail-tag";
      tag.textContent = text;
      tags.append(tag);
    }
    const statusTag = document.createElement("span");
    statusTag.className = `detail-tag ${status === true ? "status-unlocked" : "status-locked"}`;
    statusTag.textContent = status === true ? "✓ Открыто в сохранении" : status === false ? "Закрыто в сохранении" : "Загрузите сохранение для проверки";
    tags.append(statusTag);
    headCopy.append(idLine, title, english, tags);
    head.append(icon, headCopy);

    const section = document.createElement("section");
    section.className = "detail-section";
    const sectionTitle = document.createElement("h3");
    sectionTitle.textContent = "Как получить";
    const rich = document.createElement("div");
    rich.className = "rich-condition";
    renderRichCondition(rich, item.condition.parts, item.condition.text);
    section.append(sectionTitle, rich);

    const wiki = document.createElement("a");
    wiki.className = "wiki-button";
    wiki.href = item.name.wikiUrl || data.source?.pageUrl || "#";
    wiki.target = "_blank";
    wiki.rel = "noopener noreferrer";
    wiki.textContent = "Открыть статью на вики ↗";

    elements.detail.append(head, section, wiki);
    openModal(elements.detailModal);
  }

  function resetFilters() {
    state.status = "all";
    state.query = "";
    state.edition = "all";
    state.type = "all";
    state.sort = "id-asc";
    elements.search.value = "";
    elements.edition.value = "all";
    elements.type.value = "all";
    elements.sort.value = "id-asc";
    $$(".segment").forEach(button => button.classList.toggle("is-active", button.dataset.status === "all"));
    render();
  }

  // Events
  [$("#choose-file"), $("#header-load-button"), $("#replace-save")].forEach(button => {
    button.addEventListener("click", () => openModal(elements.guide));
  });
  $("#continue-file").addEventListener("click", () => { closeModal(elements.guide); elements.fileInput.click(); });
  $$('[data-close-guide]').forEach(el => el.addEventListener("click", () => closeModal(elements.guide)));
  $$('[data-close-achievement]').forEach(el => el.addEventListener("click", () => closeModal(elements.detailModal)));
  elements.fileInput.addEventListener("change", event => handleFile(event.target.files?.[0]));
  $("#steam-soon").addEventListener("click", () => showToast("Steam-синхронизация пока отключена", "Сейчас используйте файл persistentgamedata.") );
  elements.forget.addEventListener("click", () => {
    if (!confirm("Удалить сохранённый в браузере список открытых достижений? Сам файл игры не изменится.")) return;
    localStorage.removeItem(STORAGE_KEY);
    state.unlocked = null;
    state.saveMeta = null;
    state.status = "all";
    $$(".segment").forEach(button => button.classList.toggle("is-active", button.dataset.status === "all"));
    updateProgressUI();
    render();
    showToast("Прогресс сброшен", "Каталог снова показывает достижения без статуса.");
  });
  elements.search.addEventListener("input", event => { state.query = event.target.value; render(); });
  elements.edition.addEventListener("change", event => { state.edition = event.target.value; render(); });
  elements.type.addEventListener("change", event => { state.type = event.target.value; render(); });
  elements.sort.addEventListener("change", event => { state.sort = event.target.value; render(); });
  $$(".segment").forEach(button => button.addEventListener("click", () => {
    if (!state.unlocked && button.dataset.status !== "all") {
      showToast("Сначала загрузите сохранение", "После загрузки станут доступны фильтры открытых и закрытых достижений.");
      openModal(elements.guide);
      return;
    }
    state.status = button.dataset.status;
    $$(".segment").forEach(other => other.classList.toggle("is-active", other === button));
    render();
  }));
  $("#reset-filters").addEventListener("click", resetFilters);
  document.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      elements.search.focus();
    }
    if (event.key === "Escape") {
      if (!elements.detailModal.hidden) closeModal(elements.detailModal);
      else if (!elements.guide.hidden) closeModal(elements.guide);
    }
  });

  // Drag & drop anywhere on the hero.
  const hero = $(".hero");
  ["dragenter", "dragover"].forEach(type => hero.addEventListener(type, event => { event.preventDefault(); hero.classList.add("is-dragging"); }));
  ["dragleave", "drop"].forEach(type => hero.addEventListener(type, event => { event.preventDefault(); hero.classList.remove("is-dragging"); }));
  hero.addEventListener("drop", event => handleFile(event.dataTransfer?.files?.[0]));

  populateTypes();
  restoreProgress();
  updateProgressUI();
  render();
})();
