(function () {
  "use strict";

  const STORAGE_PREFIX = "shadow-lab:";
  const LAST_SESSION_KEY = `${STORAGE_PREFIX}last-session`;
  const MATERIAL_INDEX_KEY = `${STORAGE_PREFIX}materials`;
  const ACTIVE_MATERIAL_KEY = `${STORAGE_PREFIX}active-material`;
  const MEDIA_DB_NAME = "shadow-lab-media";
  const MEDIA_DB_VERSION = 2;
  const MEDIA_STORE_NAME = "files";
  const RECORDING_STORE_NAME = "recordings";
  const LAST_MEDIA_KEY = "last-media";
  const MATERIAL_RECORD_PREFIX = "material:";
  const MAX_MATERIALS = 24;
  const DONE_SCORE = 82;
  const PASSAGE_LIMITS = {
    minWords: 24,
    targetWords: 55,
    maxWords: 92,
    minDuration: 7,
    targetDuration: 16,
    maxDuration: 28,
    hardMaxDuration: 38,
    maxGap: 2.2,
    maxSentences: 4,
    hardMaxWords: 130,
  };

  const state = {
    fileId: "empty",
    materialId: "",
    fileName: "",
    subtitleText: "",
    rawEntries: [],
    segments: [],
    selectedIndex: 0,
    practiceMode: "listen",
    filter: "all",
    search: "",
    progress: defaultProgress(),
    materials: [],
    mediaUrl: "",
    mediaName: "",
    hasMedia: false,
    isPlaying: false,
    playbackRunId: 0,
    isRecording: false,
    loopSegmentIndex: null,
    loopEnabled: true,
    loopTimer: null,
    mediaStopTimer: null,
    recognition: null,
    recognitionText: "",
    recognitionAvailable: false,
    restoredSession: false,
    recorder: null,
    recordedChunks: [],
    recordStartAt: 0,
    activeStream: null,
    internalPause: false,
    suppressMediaSyncUntil: 0,
    playingAttemptId: "",
    recordingPlayer: null,
    recordingUrl: "",
    recordingBlobs: new Map(),
    recordingBlobRequests: new Map(),
  };

  const els = {};

  function init() {
    bindElements();
    bindEvents();
    initSpeechRecognition();
    loadMaterialIndex();
    restoreLastSession();
    loadProgress();
    renderAll();
    renderLibrary();
    if (state.restoredSession) toast("已恢复字幕");
    restoreInitialMaterial();
  }

  function bindElements() {
    [
      "assetInput",
      "fileStatus",
      "libraryButton",
      "libraryCount",
      "libraryPanel",
      "libraryHint",
      "libraryList",
      "exportButton",
      "resetButton",
      "metricCompleted",
      "metricAverage",
      "metricPracticed",
      "metricDue",
      "searchInput",
      "segmentList",
      "mediaPlayer",
      "ttsSurface",
      "cueIndex",
      "cueTime",
      "cueState",
      "cueProgressFill",
      "cueText",
      "prevButton",
      "playButton",
      "nextButton",
      "loopButton",
      "settingsButton",
      "settingsPanel",
      "recordButton",
      "bookmarkButton",
      "repeatInput",
      "speedInput",
      "speedOutput",
      "paddingInput",
      "paddingOutput",
      "recognitionStatus",
      "scoreValue",
      "accuracyValue",
      "paceValue",
      "bestValue",
      "recognizedText",
      "manualButtons",
      "attemptList",
    ].forEach((id) => {
      els[id] = document.getElementById(id);
    });
  }

  function bindEvents() {
    els.assetInput.addEventListener("change", handleAssetFiles);
    els.libraryButton.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleLibrary();
    });
    els.libraryPanel.addEventListener("click", (event) => {
      event.stopPropagation();
      const deleteButton = event.target.closest("button[data-delete-material-id]");
      if (deleteButton) {
        event.preventDefault();
        deleteMaterial(deleteButton.dataset.deleteMaterialId);
        return;
      }
      const button = event.target.closest("button[data-material-id]");
      if (button) loadMaterial(button.dataset.materialId);
    });
    els.searchInput.addEventListener("input", () => {
      state.search = els.searchInput.value.trim().toLowerCase();
      renderSegments();
    });
    document.querySelectorAll(".tab").forEach((button) => {
      button.addEventListener("click", () => {
        state.filter = button.dataset.filter;
        document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab === button));
        renderSegments();
        scrollSelectedSegmentIntoView({ force: true });
      });
    });
    els.prevButton.addEventListener("click", () => selectAndPlaySegment(state.selectedIndex - 1));
    els.nextButton.addEventListener("click", () => selectAndPlaySegment(state.selectedIndex + 1));
    els.playButton.addEventListener("click", () => {
      if (state.isPlaying) {
        stopLoop();
      } else {
        startLoop();
      }
    });
    els.loopButton.addEventListener("click", () => {
      state.loopEnabled = !state.loopEnabled;
      els.loopButton.classList.toggle("active", state.loopEnabled);
      toast(state.loopEnabled ? "循环已开启" : "循环已关闭");
    });
    els.settingsButton.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleSettings();
    });
    els.settingsPanel.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    document.addEventListener("click", closeSettings);
    document.addEventListener("click", closeLibrary);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeSettings();
        closeLibrary();
      }
      if (event.code === "Space" && shouldUseSpaceShortcut(event)) {
        event.preventDefault();
        toggleRecording();
      }
    });
    els.recordButton.addEventListener("click", () => {
      toggleRecording();
    });
    els.bookmarkButton.addEventListener("click", () => {
      const segment = currentSegment();
      if (!segment) return;
      toggleBookmark(segment.id);
    });
    els.repeatInput.addEventListener("change", () => {
      els.repeatInput.value = clamp(Number(els.repeatInput.value) || 3, 1, 12);
    });
    els.speedInput.addEventListener("input", () => {
      els.speedOutput.textContent = `${Number(els.speedInput.value).toFixed(2)}x`;
    });
    els.paddingInput.addEventListener("input", () => {
      els.paddingOutput.textContent = `${Number(els.paddingInput.value).toFixed(1)}s`;
    });
    els.manualButtons.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-score]");
      if (!button) return;
      saveManualScore(Number(button.dataset.score));
    });
    els.exportButton.addEventListener("click", exportProgress);
    els.resetButton.addEventListener("click", resetProgress);
    els.mediaPlayer.addEventListener("timeupdate", handleMediaTimeUpdate);
    els.mediaPlayer.addEventListener("seeking", handleMediaTimeUpdate);
    els.mediaPlayer.addEventListener("pause", () => {
      if (state.hasMedia && !state.mediaStopTimer && !state.internalPause) setPlaying(false);
    });
  }

  async function handleAssetFiles(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;

    const subtitleFile = files.find(isSubtitleFile);
    const mediaFile = files.find(isMediaFile);
    let loadedSubtitle = false;
    let loadedMedia = false;
    const reuseCurrentMaterial = Boolean(subtitleFile && !mediaFile && state.hasMedia && !state.segments.length && state.materialId);

    if (subtitleFile) {
      loadedSubtitle = await loadSubtitleFile(subtitleFile, { silent: true, reuseCurrentMaterial });
      if (loadedSubtitle && !mediaFile && !reuseCurrentMaterial) clearMedia();
    }

    if (mediaFile) {
      loadMediaFile(mediaFile);
      loadedMedia = true;
    }

    if (loadedSubtitle || loadedMedia) {
      await saveCurrentMaterial({ mediaFile });
    }

    if (loadedSubtitle && loadedMedia) {
      toast(`${state.segments.length} 段练习 + 媒体已就绪`);
    } else if (loadedSubtitle) {
      toast(`${state.segments.length} 段练习已就绪`);
    } else if (loadedMedia) {
      toast(state.segments.length ? "媒体已加载" : "媒体已加载，请再导入字幕");
    } else {
      toast("请选择字幕或音视频文件");
    }

    event.target.value = "";
  }

  async function loadSubtitleFile(file, options = {}) {
    const text = await file.text();
    const entries = parseSrt(text);
    if (!entries.length) {
      if (!options.silent) toast("没有找到有效字幕");
      return false;
    }
    state.fileName = file.name;
    state.fileId = makeFileId(file.name, text);
    if (!options.reuseCurrentMaterial) state.materialId = makeMaterialId(state.fileId);
    state.subtitleText = text;
    state.rawEntries = entries;
    state.segments = segmentEntries(entries);
    state.selectedIndex = 0;
    state.practiceMode = "listen";
    loadProgress();
    persistLastSession();
    renderAll();
    if (!options.silent) toast(`${state.segments.length} 段练习已就绪`);
    return true;
  }

  function loadMediaFile(file) {
    loadMediaBlob(file, {
      name: file.name,
      type: file.type,
      size: file.size,
      lastModified: file.lastModified,
    });
  }

  function loadMediaBlob(blob, meta = {}) {
    if (state.mediaUrl) URL.revokeObjectURL(state.mediaUrl);
    state.mediaUrl = URL.createObjectURL(blob);
    state.mediaName = meta.name || "";
    state.hasMedia = true;
    els.mediaPlayer.src = state.mediaUrl;
    els.mediaPlayer.playbackRate = Number(els.speedInput.value);
    document.querySelector(".media-frame").classList.add("has-media");
  }

  function clearMedia() {
    if (state.mediaUrl) URL.revokeObjectURL(state.mediaUrl);
    state.mediaUrl = "";
    state.mediaName = "";
    state.hasMedia = false;
    els.mediaPlayer.removeAttribute("src");
    els.mediaPlayer.load();
    document.querySelector(".media-frame").classList.remove("has-media");
  }

  function isSubtitleFile(file) {
    const name = file.name.toLowerCase();
    return name.endsWith(".srt") || name.endsWith(".vtt") || file.type === "text/plain";
  }

  function isMediaFile(file) {
    const name = file.name.toLowerCase();
    return (
      file.type.startsWith("audio/") ||
      file.type.startsWith("video/") ||
      /\.(mp3|m4a|wav|aac|aiff|aif|ogg|flac|mp4|m4v|mov|webm|mkv)$/i.test(name)
    );
  }

  function parseSrt(input) {
    const text = input.replace(/\r/g, "").replace(/^\uFEFF/, "").trim();
    const blocks = text.split(/\n{2,}/);
    const entries = [];
    for (const block of blocks) {
      const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
      const timeIndex = lines.findIndex((line) => line.includes("-->"));
      if (timeIndex < 0) continue;
      const [startRaw, endRaw] = lines[timeIndex].split("-->").map((part) => part.trim());
      const start = parseTimestamp(startRaw);
      const end = parseTimestamp(endRaw);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const caption = lines
        .slice(timeIndex + 1)
        .join(" ")
        .replace(/<[^>]+>/g, "")
        .replace(/\{\\.*?\}/g, "")
        .replace(/^[-–> ]+/, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!caption) continue;
      entries.push({ start, end: Math.max(end, start + 0.2), text: caption });
    }
    return entries;
  }

  function parseTimestamp(value) {
    const match = value.match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/);
    if (!match) return NaN;
    const hours = Number(match[1] || 0);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    const millis = Number(match[4].padEnd(3, "0"));
    return hours * 3600 + minutes * 60 + seconds + millis / 1000;
  }

  function segmentEntries(entries) {
    const sentenceUnits = buildSentenceUnits(entries);
    const chunks = [];
    let bucket = [];

    const flush = () => {
      if (!bucket.length) return;
      chunks.push(bucket);
      bucket = [];
    };

    for (const unit of sentenceUnits) {
      const gap = bucket.length ? unit.start - bucket[bucket.length - 1].end : 0;
      if (bucket.length && gap > PASSAGE_LIMITS.maxGap) {
        const stats = passageStats(bucket);
        if (stats.words >= PASSAGE_LIMITS.minWords || stats.duration >= PASSAGE_LIMITS.minDuration) {
          flush();
        }
      }

      if (bucket.length && shouldCloseBeforeAdding(bucket, unit)) flush();

      bucket.push(unit);

      const stats = passageStats(bucket);
      const sentenceCount = bucket.reduce((total, item) => total + (item.sentenceCount || 1), 0);
      const hasEnoughBody =
        stats.words >= PASSAGE_LIMITS.minWords &&
        stats.duration >= PASSAGE_LIMITS.minDuration;
      const oneLongCompleteThought =
        sentenceCount === 1 &&
        hasEnoughBody &&
        (stats.words >= PASSAGE_LIMITS.targetWords || stats.duration >= PASSAGE_LIMITS.targetDuration);
      const reachedTarget =
        (sentenceCount >= 2 || oneLongCompleteThought) &&
        hasEnoughBody &&
        (stats.words >= PASSAGE_LIMITS.targetWords ||
          stats.duration >= PASSAGE_LIMITS.targetDuration ||
          sentenceCount >= 3);
      const reachedSoftLimit =
        hasEnoughBody &&
        (stats.words >= PASSAGE_LIMITS.maxWords ||
          stats.duration >= PASSAGE_LIMITS.maxDuration ||
          sentenceCount >= PASSAGE_LIMITS.maxSentences);
      const hardBreak =
        stats.words >= PASSAGE_LIMITS.hardMaxWords ||
        stats.duration >= PASSAGE_LIMITS.hardMaxDuration;

      if (reachedTarget || reachedSoftLimit || hardBreak) flush();
    }
    flush();
    return mergeShortChunks(chunks)
      .map((chunk, index) => makeSegment(chunk, index))
      .filter((segment) => segment.text.length > 1);
  }

  function shouldCloseBeforeAdding(bucket, nextUnit) {
    const currentStats = passageStats(bucket);
    const currentSentences = bucket.reduce((total, item) => total + (item.sentenceCount || 1), 0);
    const currentCanStand =
      currentStats.words >= PASSAGE_LIMITS.minWords &&
      (currentSentences >= 2 ||
        currentStats.words >= PASSAGE_LIMITS.targetWords ||
        currentStats.duration >= PASSAGE_LIMITS.targetDuration);
    if (!currentCanStand) return false;

    const combined = bucket.concat(nextUnit);
    const combinedStats = passageStats(combined);
    const combinedSentences = combined.reduce((total, item) => total + (item.sentenceCount || 1), 0);
    return (
      combinedStats.words > PASSAGE_LIMITS.maxWords ||
      combinedStats.duration > PASSAGE_LIMITS.maxDuration ||
      combinedSentences > PASSAGE_LIMITS.maxSentences
    );
  }

  function buildSentenceUnits(entries) {
    const units = [];
    let tokens = [];

    const flush = (count = tokens.length) => {
      const chunk = tokens.slice(0, count);
      if (!chunk.length) return;
      const text = cleanDisplayText(chunk.map((token) => token.text).join(" "));
      if (text) {
        units.push({
          start: chunk[0].start,
          end: chunk[chunk.length - 1].end,
          text,
          sentenceCount: Math.max(1, countSentenceEndings(text)),
        });
      }
      tokens = tokens.slice(count);
    };

    for (const entry of entries) {
      const entryTokens = timedTokensForEntry(entry);
      for (const token of entryTokens) {
        const gap = tokens.length ? token.start - tokens[tokens.length - 1].end : 0;
        if (tokens.length && gap > PASSAGE_LIMITS.maxGap && unitStats(tokens).words >= 8) flush();

        tokens.push(token);
        const stats = unitStats(tokens);
        const cleanSentenceEnd = isSentenceEndToken(token.text) && !hasDanglingEnding(stats.text);
        const softPhraseEnd = isSoftBreakToken(token.text) && stats.words >= PASSAGE_LIMITS.targetWords;
        const overflow =
          stats.words >= PASSAGE_LIMITS.maxWords ||
          stats.duration >= PASSAGE_LIMITS.maxDuration;
        const hardOverflow =
          stats.words >= PASSAGE_LIMITS.hardMaxWords ||
          stats.duration >= PASSAGE_LIMITS.hardMaxDuration;

        if (cleanSentenceEnd || softPhraseEnd) flush();
        else if (overflow || hardOverflow) {
          const breakIndex = bestSoftBreakIndex(tokens);
          flush(breakIndex >= 0 ? breakIndex + 1 : tokens.length);
        }
      }
    }
    flush();
    return units.length ? units : entries;
  }

  function timedTokensForEntry(entry) {
    const words = entry.text.match(/\S+/g) || [];
    if (!words.length) return [];
    const duration = Math.max(0.2, entry.end - entry.start);
    return words.map((word, index) => {
      const start = entry.start + (duration * index) / words.length;
      const end = entry.start + (duration * (index + 1)) / words.length;
      return { text: word, start, end: Math.max(end, start + 0.02) };
    });
  }

  function unitStats(tokens) {
    const text = cleanDisplayText(tokens.map((token) => token.text).join(" "));
    return {
      text,
      duration: tokens[tokens.length - 1].end - tokens[0].start,
      words: tokenizeWords(text).length,
    };
  }

  function bestSoftBreakIndex(tokens) {
    let bestIndex = -1;
    let bestScore = Infinity;
    for (let index = 0; index < tokens.length - 1; index += 1) {
      const stats = unitStats(tokens.slice(0, index + 1));
      if (stats.words < PASSAGE_LIMITS.minWords || stats.duration < PASSAGE_LIMITS.minDuration) continue;

      const current = tokens[index].text;
      const next = tokens[index + 1] && tokens[index + 1].text;
      const sentenceEnd = isSentenceEndToken(current);
      const softBreak = isSoftBreakToken(current);
      const clauseBreak = startsNewClause(next);
      if (!sentenceEnd && !softBreak && !clauseBreak) continue;

      const score =
        Math.abs(stats.words - PASSAGE_LIMITS.targetWords) +
        Math.abs(stats.duration - PASSAGE_LIMITS.targetDuration) * 2 +
        (sentenceEnd ? -18 : 0) +
        (softBreak ? -8 : 0) +
        (clauseBreak ? -3 : 0);
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    return bestIndex;
  }

  function mergeShortChunks(chunks) {
    const merged = [];
    for (const chunk of chunks) {
      if (!chunk.length) continue;
      const stats = passageStats(chunk);
      const previous = merged[merged.length - 1];
      if (previous && shouldMergeShortChunk(previous, chunk, stats)) {
        previous.push(...chunk);
      } else {
        merged.push(chunk.slice());
      }
    }
    return merged;
  }

  function shouldMergeShortChunk(previous, chunk, stats) {
    const combined = previous.concat(chunk);
    const combinedStats = passageStats(combined);
    const isShort = stats.words < PASSAGE_LIMITS.minWords || stats.duration < PASSAGE_LIMITS.minDuration;
    const stillPractical =
      combinedStats.words <= PASSAGE_LIMITS.hardMaxWords &&
      combinedStats.duration <= PASSAGE_LIMITS.hardMaxDuration;
    return isShort && stillPractical;
  }

  function passageStats(bucket) {
    const text = bucket.map((item) => item.text).join(" ");
    return {
      text,
      duration: bucket[bucket.length - 1].end - bucket[0].start,
      words: tokenizeWords(text).length,
    };
  }

  function countSentenceEndings(text) {
    const matches = text.match(/[.!?。！？]+["')\]]?/g);
    return matches ? matches.length : 0;
  }

  function isSentenceEndToken(token) {
    return /[.!?。！？]+["')\]]?$/.test(token) && !isLikelyAbbreviation(token);
  }

  function isSoftBreakToken(token) {
    return /[,;:，；：]["')\]]?$/.test(token);
  }

  function startsNewClause(token) {
    if (!token) return false;
    const normalized = token.toLowerCase().replace(/^[("'[\]]+|[,.!?;:，。！？；："')\]]+$/g, "");
    return /^(and|but|so|then|because|where|which|when|while|if|um|uh|anyway|actually|also|now)$/.test(normalized);
  }

  function isLikelyAbbreviation(token) {
    const normalized = token.toLowerCase().replace(/["')\]]+$/g, "");
    return /^(mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e)\.$/.test(normalized);
  }

  function hasDanglingEnding(text) {
    const normalized = text.toLowerCase().replace(/[.!?。！？"')\]]+$/g, "").trim();
    const last = normalized.split(/\s+/).pop() || "";
    return /^(and|but|or|so|because|while|though|although|if|when|that|which|who|to|of|in|on|at|for|with|from|by|as|is|are|was|were|be|been|being|the|a|an)$/.test(last);
  }

  function makeSegment(bucket, index) {
    const start = bucket[0].start;
    const end = bucket[bucket.length - 1].end;
    return {
      id: `seg-${index + 1}`,
      index,
      start,
      end,
      text: cleanDisplayText(bucket.map((item) => item.text).join(" ")),
      phrases: timedPhraseGroupsForBucket(bucket),
      entryCount: bucket.length,
    };
  }

  function timedPhraseGroupsForBucket(bucket) {
    const phrases = [];
    bucket.forEach((unit, unitIndex) => {
      const chunks = splitPhraseText(unit.text);
      const totalWeight = chunks.reduce((total, text) => total + phraseWeight(text), 0) || chunks.length || 1;
      let elapsedWeight = 0;
      chunks.forEach((text) => {
        const weight = phraseWeight(text);
        const start = unit.start + ((unit.end - unit.start) * elapsedWeight) / totalWeight;
        elapsedWeight += weight;
        const end = unit.start + ((unit.end - unit.start) * elapsedWeight) / totalWeight;
        phrases.push({
          text,
          start,
          end: Math.max(end, start + 0.12),
          boundary: unitIndex > 0 && elapsedWeight === weight,
        });
      });
    });
    return phrases.map((phrase, index) => ({ ...phrase, index }));
  }

  function splitPhraseText(text) {
    const clauses = String(text)
      .split(/(?<=[.;:!?。！？；：])\s+/)
      .map((part) => cleanDisplayText(part))
      .filter(Boolean);
    const source = clauses.length ? clauses : [cleanDisplayText(text)];
    const chunks = [];
    source.forEach((clause) => {
      const words = clause.match(/\S+/g) || [];
      if (words.length <= 9) {
        chunks.push(clause);
        return;
      }
      for (let index = 0; index < words.length; index += 7) {
        chunks.push(words.slice(index, index + 7).join(" "));
      }
    });
    return chunks.length ? chunks : [cleanDisplayText(text)];
  }

  function phraseWeight(text) {
    return Math.max(1, tokenizeWords(text).length);
  }

  function cleanDisplayText(text) {
    return text
      .replace(/\s+([,.!?;:])/g, "$1")
      .replace(/\s+/g, " ")
      .replace(/\[ __ \]/g, "")
      .trim();
  }

  function renderAll() {
    renderStatus();
    renderMetrics();
    renderSegments();
    renderCue();
    renderBookmarkButton();
    renderScore();
    renderAttempts();
    renderLibrary();
  }

  function renderStatus() {
    const segmentCount = state.segments.length;
    if (segmentCount) {
      els.fileStatus.textContent = `${state.fileName} · ${segmentCount} 段练习`;
    } else if (state.mediaName) {
      els.fileStatus.textContent = `${state.mediaName} · 等待字幕`;
    } else {
      els.fileStatus.textContent = "未加载字幕";
    }
    els.recognitionStatus.textContent = state.recognitionAvailable ? "语音: 开" : "语音: 关";
  }

  function renderLibrary() {
    if (!els.libraryList) return;
    els.libraryCount.textContent = String(state.materials.length);
    els.libraryList.innerHTML = "";
    els.libraryHint.textContent = state.materials.length ? "点击即可切换" : "导入后会保留在这里";
    if (!state.materials.length) {
      const empty = document.createElement("li");
      empty.className = "library-empty";
      empty.textContent = "还没有素材记录。";
      els.libraryList.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    state.materials.forEach((material) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      const deleteButton = document.createElement("button");
      const isActive = material.id === state.materialId;
      const title = material.subtitleName || material.mediaName || "未命名素材";
      const detail = [
        material.segmentCount ? `${material.segmentCount} 段` : "待配字幕",
        material.mediaName ? "有媒体" : "无媒体",
        formatLibraryTime(material.updatedAt || material.savedAt),
      ].filter(Boolean).join(" · ");
      li.className = "library-row";
      button.type = "button";
      button.dataset.materialId = material.id;
      button.className = `library-item${isActive ? " active" : ""}`;
      button.innerHTML = `
        <span>${escapeHtml(title)}</span>
        <small>${escapeHtml(detail)}</small>
      `;
      deleteButton.type = "button";
      deleteButton.dataset.deleteMaterialId = material.id;
      deleteButton.className = "library-delete";
      deleteButton.title = "删除素材记录";
      deleteButton.setAttribute("aria-label", `删除素材记录：${title}`);
      deleteButton.innerHTML = '<svg><use href="#icon-trash"></use></svg>';
      li.appendChild(button);
      li.appendChild(deleteButton);
      fragment.appendChild(li);
    });
    els.libraryList.appendChild(fragment);
  }

  function renderMetrics() {
    const total = state.segments.length;
    const stats = collectStats();
    els.metricCompleted.textContent = total ? `${Math.round((stats.done / total) * 100)}%` : "0%";
    els.metricAverage.textContent = stats.scored ? `${Math.round(stats.average)}` : "--";
    els.metricPracticed.textContent = String(stats.attempts);
    els.metricDue.textContent = String(Math.max(0, total - stats.done));
  }

  function renderSegments() {
    els.segmentList.innerHTML = "";
    const visible = state.segments.filter((segment) => {
      const best = bestScore(segment.id);
      const done = best >= DONE_SCORE;
      if (state.filter === "bookmarked" && !isBookmarked(segment.id)) return false;
      if (state.filter === "due" && done) return false;
      if (state.filter === "done" && !done) return false;
      if (state.search && !segment.text.toLowerCase().includes(state.search)) return false;
      return true;
    });

    if (!visible.length) {
      const empty = document.createElement("li");
      empty.className = "segment-empty";
      empty.textContent = emptySegmentMessage();
      els.segmentList.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    visible.forEach((segment) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      const best = bestScore(segment.id);
      const scoreClass = best >= DONE_SCORE ? "good" : best ? "mid" : "";
      button.className = `segment-item${segment.index === state.selectedIndex ? " active" : ""}`;
      button.type = "button";
      button.title = "选择并播放";
      button.innerHTML = `
        <span class="seg-no">${segment.index + 1}</span>
        <span class="seg-copy">
          <p>${escapeHtml(segment.text)}</p>
          <span>${formatTime(segment.start)} - ${formatTime(segment.end)}</span>
        </span>
        <span class="seg-score ${scoreClass}">${best ? Math.round(best) : "--"}</span>
      `;
      button.addEventListener("click", () => selectAndPlaySegment(segment.index));
      li.appendChild(button);
      fragment.appendChild(li);
    });
    els.segmentList.appendChild(fragment);
  }

  function scrollSelectedSegmentIntoView(options = {}) {
    const { behavior = "smooth", force = false } = options;
    window.requestAnimationFrame(() => {
      const active = els.segmentList.querySelector(".segment-item.active");
      if (!active) return;
      const listRect = els.segmentList.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      const isVisible = activeRect.top >= listRect.top && activeRect.bottom <= listRect.bottom;
      if (isVisible && !force) return;
      const targetTop =
        els.segmentList.scrollTop +
        activeRect.top -
        listRect.top -
        (listRect.height - activeRect.height) / 2;
      try {
        els.segmentList.scrollTo({ top: Math.max(0, targetTop), behavior });
      } catch (error) {
        els.segmentList.scrollTop = Math.max(0, targetTop);
      }
    });
  }

  function emptySegmentMessage() {
    if (state.search) return "没有匹配的段落。";
    if (state.filter === "bookmarked") return "还没有收藏段落。";
    if (state.filter === "due") return "没有待练段落。";
    if (state.filter === "done") return "还没有已过段落。";
    return "导入字幕开始练习。";
  }

  function renderCue() {
    const segment = currentSegment();
    if (!segment) {
      setCueHoverLabel("");
      els.cueIndex.textContent = "--";
      els.cueTime.textContent = "00:00.000 - 00:00.000";
      els.cueState.textContent = state.isPlaying ? "播放中" : "待机";
      updateCueProgress(null, null);
      renderCuePlaceholder("导入字幕开始练习。");
      renderBookmarkButton();
      return;
    }
    els.cueIndex.textContent = `${segment.index + 1}/${state.segments.length}`;
    els.cueTime.textContent = `${formatTime(segment.start)} - ${formatTime(segment.end)}`;
    els.cueState.textContent = cueStateLabel();
    setCueHoverLabel(state.isRecording ? "录音中" : modeLabel());
    renderCuePhrases(segment);
    updateStudyProgress(currentPlaybackTime(), { force: true });
    renderBookmarkButton();
  }

  function renderBookmarkButton() {
    if (!els.bookmarkButton) return;
    const segment = currentSegment();
    const bookmarked = Boolean(segment && isBookmarked(segment.id));
    els.bookmarkButton.disabled = !segment;
    els.bookmarkButton.classList.toggle("active", bookmarked);
    els.bookmarkButton.title = bookmarked ? "取消收藏当前段落" : "收藏当前段落";
    els.bookmarkButton.setAttribute("aria-label", bookmarked ? "取消收藏当前段落" : "收藏当前段落");
    els.bookmarkButton.setAttribute("aria-pressed", String(bookmarked));
  }

  function modeLabel() {
    return "盲听";
  }

  function cueStateLabel() {
    if (state.isRecording) return "录音中";
    if (state.isPlaying) return `${modeLabel()}中`;
    return modeLabel();
  }

  function renderCuePlaceholder(text) {
    setCueHoverLabel("");
    els.cueText.className = "is-hidden";
    els.cueText.textContent = text;
  }

  function renderCuePhrases(segment) {
    els.cueText.className = "cue-subtitle";
    els.cueText.innerHTML = "";
    const fragment = document.createDocumentFragment();
    const phrases = segment.phrases && segment.phrases.length
      ? segment.phrases
      : timedPhraseGroupsForBucket([{ text: segment.text, start: segment.start, end: segment.end }]);
    phrases.forEach((phrase, index) => {
      if (index > 0) fragment.appendChild(document.createTextNode(" "));
      const span = document.createElement("span");
      span.className = "cue-phrase";
      span.dataset.phraseIndex = String(phrase.index);
      span.textContent = phrase.text;
      fragment.appendChild(span);
    });
    els.cueText.appendChild(fragment);
  }

  function setCueHoverLabel(label) {
    const cue = els.cueText.closest(".cue");
    if (!cue) return;
    if (label) cue.dataset.cueLabel = label;
    else delete cue.dataset.cueLabel;
  }

  function renderScore() {
    const segment = currentSegment();
    const latest = segment ? latestAttempt(segment.id) : null;
    const best = segment ? bestScore(segment.id) : 0;
    const score = latest && Number.isFinite(latest.score) ? latest.score : null;
    const accuracy = latest && Number.isFinite(latest.accuracy) ? latest.accuracy : null;
    const pace = latest && Number.isFinite(latest.pace) ? latest.pace : null;
    els.scoreValue.textContent = score === null ? "--" : Math.round(score);
    document.querySelector(".score-ring").style.setProperty("--score", `${score || 0}%`);
    els.accuracyValue.textContent = accuracy === null ? "--" : `${Math.round(accuracy)}`;
    els.paceValue.textContent = pace === null ? "--" : `${Math.round(pace)}`;
    els.bestValue.textContent = best ? `${Math.round(best)}` : "--";
    els.recognizedText.textContent = latest && latest.recognized ? latest.recognized : "还没有练习记录。";
    document.querySelectorAll("#manualButtons button").forEach((button) => {
      button.classList.toggle("active", latest && latest.manual === Number(button.dataset.score));
    });
  }

  function renderAttempts() {
    els.attemptList.innerHTML = "";
    const items = state.progress.history.slice(0, 8);
    if (!items.length) {
      const li = document.createElement("li");
      li.innerHTML = "<b>--</b><p><span>暂无练习记录</span>练一次后这里会显示历史。</p><button class=\"attempt-play\" type=\"button\" disabled aria-hidden=\"true\"></button>";
      els.attemptList.appendChild(li);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const attempt of items) {
      const segment = state.segments.find((item) => item.id === attempt.segmentId);
      const li = document.createElement("li");
      const score = attempt.score ? Math.round(attempt.score) : attempt.manual ? attempt.manual : "--";
      const isPlaying = state.playingAttemptId === attempt.id;
      li.innerHTML = `
        <b>${score}</b>
        <p><span>${segment ? escapeHtml(segment.text) : "之前的练习段"}</span>${new Date(attempt.at).toLocaleString()}</p>
        <button class="attempt-play${isPlaying ? " active" : ""}" type="button" title="复听录音" ${attempt.audioId ? "" : "disabled aria-hidden=\"true\""}>
          <svg><use href="#${isPlaying ? "icon-pause" : "icon-play"}"></use></svg>
        </button>
      `;
      const button = li.querySelector(".attempt-play");
      if (button && attempt.audioId) {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          playAttemptRecording(attempt);
        });
      }
      fragment.appendChild(li);
    }
    els.attemptList.appendChild(fragment);
    primeAttemptRecordings(items);
  }

  async function playAttemptRecording(attempt) {
    if (!attempt || !attempt.audioId) return;
    if (state.playingAttemptId === attempt.id) {
      stopAttemptPlayback();
      return;
    }
    focusAttemptSegment(attempt);
    stopLoop({ silent: true });
    stopAttemptPlayback({ silent: true });
    try {
      let blob = state.recordingBlobs.get(attempt.audioId);
      if (!blob) blob = await getAttemptRecordingBlob(attempt.audioId);
      if (!blob || !blob.size) {
        toast("这条录音不可用，请重新录一次");
        return;
      }
      const url = URL.createObjectURL(blob);
      const audio = document.createElement("audio");
      audio.src = url;
      audio.preload = "auto";
      audio.muted = false;
      audio.volume = 1;
      audio.playsInline = true;
      audio.style.display = "none";
      document.body.appendChild(audio);
      state.recordingPlayer = audio;
      state.recordingUrl = url;
      state.playingAttemptId = attempt.id;
      audio.onended = () => stopAttemptPlayback();
      audio.onerror = () => {
        toast("录音播放失败");
        stopAttemptPlayback();
      };
      renderAttempts();
      await audio.play();
    } catch (error) {
      stopAttemptPlayback();
      toast("录音播放失败");
    }
  }

  function primeAttemptRecordings(attempts) {
    attempts.forEach((attempt) => {
      if (attempt.audioId) getAttemptRecordingBlob(attempt.audioId).catch(() => {});
    });
  }

  function getAttemptRecordingBlob(audioId) {
    if (!audioId) return Promise.resolve(null);
    if (state.recordingBlobs.has(audioId)) return Promise.resolve(state.recordingBlobs.get(audioId));
    if (state.recordingBlobRequests.has(audioId)) return state.recordingBlobRequests.get(audioId);
    const request = recordingDbRequest("readonly", (store) => store.get(audioId))
      .then((record) => {
        const blob = record && record.blob && record.blob.size ? record.blob : null;
        if (blob) state.recordingBlobs.set(audioId, blob);
        return blob;
      })
      .finally(() => {
        state.recordingBlobRequests.delete(audioId);
      });
    state.recordingBlobRequests.set(audioId, request);
    return request;
  }

  function focusAttemptSegment(attempt) {
    const index = state.segments.findIndex((segment) => segment.id === attempt.segmentId);
    if (index < 0) return;
    state.selectedIndex = index;
    state.practiceMode = "listen";
    persistLastSession();
    renderSegments();
    scrollSelectedSegmentIntoView({ force: true });
    renderCue();
    renderBookmarkButton();
    renderScore();
  }

  function stopAttemptPlayback(options = {}) {
    if (state.recordingPlayer) {
      state.recordingPlayer.pause();
      state.recordingPlayer.removeAttribute("src");
      state.recordingPlayer.load();
      if (state.recordingPlayer.parentNode) state.recordingPlayer.parentNode.removeChild(state.recordingPlayer);
      state.recordingPlayer = null;
    }
    if (state.recordingUrl) {
      URL.revokeObjectURL(state.recordingUrl);
      state.recordingUrl = "";
    }
    const wasPlaying = Boolean(state.playingAttemptId);
    state.playingAttemptId = "";
    if (wasPlaying && !options.silent) renderAttempts();
  }

  function selectSegment(index) {
    if (!state.segments.length) return;
    state.selectedIndex = clamp(index, 0, state.segments.length - 1);
    state.practiceMode = "listen";
    persistLastSession();
    closeSettings();
    stopLoop({ silent: true });
    renderSegments();
    scrollSelectedSegmentIntoView();
    renderCue();
    renderBookmarkButton();
    renderScore();
  }

  function selectAndPlaySegment(index) {
    if (!state.segments.length) return;
    selectSegment(index);
    window.setTimeout(() => {
      if (state.segments.length) startLoop();
    }, 0);
  }

  function currentSegment() {
    return state.segments[state.selectedIndex] || null;
  }

  function currentPlaybackTime() {
    return state.hasMedia && Number.isFinite(els.mediaPlayer.currentTime)
      ? els.mediaPlayer.currentTime
      : null;
  }

  function handleMediaTimeUpdate() {
    if (!state.hasMedia) return;
    const time = els.mediaPlayer.currentTime;
    if (shouldSyncMediaToSegment()) syncSegmentToMediaTime(time);
    updateStudyProgress(time);
  }

  function shouldSyncMediaToSegment() {
    return state.loopSegmentIndex === null && !state.internalPause && Date.now() >= state.suppressMediaSyncUntil;
  }

  function suppressMediaSync(duration = 700) {
    state.suppressMediaSyncUntil = Date.now() + duration;
  }

  function syncSegmentToMediaTime(time) {
    if (!state.segments.length || !Number.isFinite(time)) return;
    const current = currentSegment();
    if (current && time >= current.start && time <= current.end) return;
    const nextIndex = state.segments.findIndex((segment) => time >= segment.start && time <= segment.end);
    if (nextIndex < 0 || nextIndex === state.selectedIndex) return;
    state.selectedIndex = nextIndex;
    state.practiceMode = "listen";
    persistLastSession();
    renderSegments();
    renderCue();
    renderBookmarkButton();
    renderScore();
  }

  function updateStudyProgress(time, options = {}) {
    const segment = state.loopSegmentIndex === null
      ? currentSegment()
      : state.segments[state.loopSegmentIndex];
    updateCueProgress(time, segment);
    if (!Number.isFinite(time)) return;
    if (!segment || !segment.phrases) return;
    const phrases = els.cueText.querySelectorAll(".cue-phrase");
    if (!phrases.length) return;
    phrases.forEach((phrase) => {
      const item = segment.phrases[Number(phrase.dataset.phraseIndex)];
      const isActive = item && time >= item.start && time < item.end;
      const isPast = item && time >= item.end;
      phrase.classList.toggle("active", Boolean(isActive));
      phrase.classList.toggle("past", Boolean(isPast || isActive));
      if (options.force && item && time < item.start) {
        phrase.classList.remove("active", "past");
      }
    });
  }

  function updateCueProgress(time, segment) {
    if (!els.cueProgressFill) return;
    if (!segment || !Number.isFinite(time)) {
      els.cueProgressFill.style.width = "0%";
      return;
    }
    const progress = clamp((time - segment.start) / Math.max(0.1, segment.end - segment.start), 0, 1);
    els.cueProgressFill.style.width = `${Math.round(progress * 100)}%`;
  }

  function toggleSettings() {
    const isOpen = els.settingsPanel.classList.toggle("open");
    els.settingsButton.classList.toggle("active", isOpen);
    els.settingsButton.setAttribute("aria-expanded", String(isOpen));
  }

  function closeSettings() {
    if (!els.settingsPanel || !els.settingsButton) return;
    els.settingsPanel.classList.remove("open");
    els.settingsButton.classList.remove("active");
    els.settingsButton.setAttribute("aria-expanded", "false");
  }

  function toggleLibrary() {
    const isOpen = els.libraryPanel.classList.toggle("open");
    els.libraryButton.classList.toggle("active", isOpen);
    els.libraryButton.setAttribute("aria-expanded", String(isOpen));
    if (isOpen) closeSettings();
  }

  function closeLibrary() {
    if (!els.libraryPanel || !els.libraryButton) return;
    els.libraryPanel.classList.remove("open");
    els.libraryButton.classList.remove("active");
    els.libraryButton.setAttribute("aria-expanded", "false");
  }

  async function startLoop() {
    const segment = currentSegment();
    if (!segment) {
      toast("请先导入字幕");
      return;
    }
    stopLoop({ silent: true });
    const runId = state.playbackRunId + 1;
    state.playbackRunId = runId;
    state.loopSegmentIndex = segment.index;
    setPlaying(true);
    const repeats = state.loopEnabled ? Number(els.repeatInput.value) || 3 : 1;
    for (let i = 0; i < repeats && state.isPlaying && state.playbackRunId === runId; i += 1) {
      if (state.hasMedia) await playMediaSegment(segment, runId);
      else await speakSegment(segment);
      if (state.loopEnabled && i < repeats - 1 && state.isPlaying && state.playbackRunId === runId) await wait(450);
    }
    if (state.playbackRunId !== runId) return;
    const completed = state.isPlaying;
    if (completed) state.selectedIndex = segment.index;
    suppressMediaSync(900);
    state.loopSegmentIndex = null;
    setPlaying(false);
    if (completed) {
      renderSegments();
      renderScore();
      renderCue();
    }
  }

  function stopLoop(options = {}) {
    if (!options.keepRunId) state.playbackRunId += 1;
    clearTimeout(state.loopTimer);
    clearTimeout(state.mediaStopTimer);
    state.loopTimer = null;
    state.mediaStopTimer = null;
    suppressMediaSync();
    state.loopSegmentIndex = null;
    if (state.hasMedia) {
      state.internalPause = true;
      els.mediaPlayer.pause();
      setTimeout(() => {
        state.internalPause = false;
      }, 0);
    }
    window.speechSynthesis.cancel();
    setPlaying(false);
    if (!options.silent) toast("已停止");
  }

  function setPlaying(value) {
    state.isPlaying = value;
    els.playButton.innerHTML = `<svg><use href="#${value ? "icon-pause" : "icon-play"}"></use></svg>`;
    renderCue();
  }

  function playMediaSegment(segment, runId) {
    return new Promise((resolve) => {
      const isActiveRun = () => state.playbackRunId === runId;
      const padding = Number(els.paddingInput.value) || 0;
      const start = Math.max(0, segment.start - padding);
      const end = segment.end + padding;
      els.mediaPlayer.playbackRate = Number(els.speedInput.value);
      suppressMediaSync();
      els.mediaPlayer.currentTime = start;
      updateStudyProgress(start, { force: true });
      const finish = () => {
        clearTimeout(state.mediaStopTimer);
        state.mediaStopTimer = null;
        if (!isActiveRun()) {
          resolve();
          return;
        }
        state.internalPause = true;
        suppressMediaSync(900);
        els.mediaPlayer.pause();
        updateStudyProgress(end, { force: true });
        setTimeout(() => {
          state.internalPause = false;
        }, 0);
        resolve();
      };
      const tick = () => {
        if (!state.isPlaying || !isActiveRun()) return finish();
        updateStudyProgress(els.mediaPlayer.currentTime);
        if (els.mediaPlayer.currentTime >= end) return finish();
        state.mediaStopTimer = setTimeout(tick, 80);
      };
      els.mediaPlayer.play().then(() => {
        if (isActiveRun()) tick();
        else resolve();
      }).catch(() => {
        if (isActiveRun()) toast("媒体播放被浏览器拦截");
        finish();
      });
    });
  }

  function speakSegment(segment) {
    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(segment.text);
      utterance.lang = guessSpeechLang(segment.text);
      utterance.rate = Number(els.speedInput.value);
      utterance.onend = resolve;
      utterance.onerror = resolve;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    });
  }

  async function startRecording() {
    const segment = currentSegment();
    if (!segment) {
      toast("请先导入字幕");
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast("无法使用麦克风");
      return;
    }
    if (!window.MediaRecorder) {
      toast("当前浏览器不能录音");
      return;
    }
    try {
      stopLoop({ silent: true });
      stopAttemptPlayback({ silent: true });
      state.practiceMode = "listen";
      state.activeStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.recordedChunks = [];
      state.recognitionText = "";
      state.recorder = createMediaRecorder(state.activeStream);
      state.recorder.ondataavailable = (event) => {
        if (event.data && event.data.size) state.recordedChunks.push(event.data);
      };
      state.recorder.onstop = () => {
        finalizeRecording();
      };
      state.recordStartAt = performance.now();
      state.recorder.start();
      startSpeechRecognition(segment.text);
      state.isRecording = true;
      els.recordButton.classList.add("recording");
      els.recordButton.innerHTML = '<svg><use href="#icon-stop"></use></svg>';
      renderCue();
      toast("录音中");
    } catch (error) {
      stopActiveStream();
      toast("录音启动失败");
    }
  }

  function toggleRecording() {
    if (state.isRecording) stopRecording();
    else startRecording();
  }

  function shouldUseSpaceShortcut(event) {
    if (event.defaultPrevented || event.repeat) return false;
    const target = event.target;
    if (!target) return true;
    const tag = target.tagName ? target.tagName.toLowerCase() : "";
    return !target.isContentEditable && !["input", "textarea", "select"].includes(tag);
  }

  function stopRecording() {
    if (state.recorder && state.recorder.state !== "inactive") {
      try {
        state.recorder.requestData();
      } catch (error) {
        // Some browsers only flush data during stop.
      }
      state.recorder.stop();
    } else {
      stopActiveStream();
    }
    stopSpeechRecognition();
    state.isRecording = false;
    els.recordButton.classList.remove("recording");
    els.recordButton.innerHTML = '<svg><use href="#icon-mic"></use></svg>';
    renderCue();
  }

  async function finalizeRecording() {
    try {
      const segment = currentSegment();
      if (!segment) return;
      const duration = Math.max(0.1, (performance.now() - state.recordStartAt) / 1000);
      const recognized = state.recognitionText.trim();
      const auto = recognized ? scoreAttempt(segment.text, recognized, segment.end - segment.start, duration) : null;
      const attemptId = `attempt-${Date.now()}`;
      const audioBlob = makeRecordingBlob();
      let audioId = "";
      if (audioBlob && audioBlob.size) {
        audioId = attemptId;
        try {
          await cacheRecordingBlob(audioId, audioBlob, {
            segmentId: segment.id,
            duration,
            at: Date.now(),
          });
        } catch (error) {
          audioId = "";
          toast("录音保存失败");
        }
      }
      const attempt = {
        id: attemptId,
        segmentId: segment.id,
        at: Date.now(),
        duration,
        recognized,
        score: auto ? auto.score : null,
        accuracy: auto ? auto.accuracy : null,
        pace: auto ? auto.pace : null,
        manual: null,
        audioId,
        audioType: audioBlob ? audioBlob.type : "",
      };
      saveAttempt(attempt);
      renderAll();
      toast(recognized ? `得分 ${Math.round(auto.score)}` : "已保存，可手动评分");
    } finally {
      stopActiveStream();
      state.recorder = null;
      state.recordedChunks = [];
    }
  }

  function makeRecordingBlob() {
    if (!state.recordedChunks.length) return null;
    const type = state.recordedChunks.find((chunk) => chunk.type)?.type || "audio/webm";
    return new Blob(state.recordedChunks, { type });
  }

  function createMediaRecorder(stream) {
    const mimeType = preferredRecordingMimeType();
    return mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  }

  function preferredRecordingMimeType() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
    return [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/aac",
    ].find((type) => MediaRecorder.isTypeSupported(type)) || "";
  }

  function stopActiveStream() {
    if (!state.activeStream) return;
    state.activeStream.getTracks().forEach((track) => track.stop());
    state.activeStream = null;
  }

  function cacheRecordingBlob(id, blob, meta = {}) {
    if (!blob || !window.indexedDB) return Promise.reject(new Error("Recording storage unavailable"));
    state.recordingBlobs.set(id, blob);
    return recordingDbRequest("readwrite", (store) =>
      store.put(
        {
          id,
          blob,
          type: blob.type,
          segmentId: meta.segmentId || "",
          duration: meta.duration || 0,
          at: meta.at || Date.now(),
        },
        id
      )
    );
  }

  function initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      state.recognitionAvailable = false;
      return;
    }
    state.recognitionAvailable = true;
    state.recognition = new SpeechRecognition();
    state.recognition.continuous = true;
    state.recognition.interimResults = true;
    state.recognition.onresult = (event) => {
      let text = "";
      for (let i = 0; i < event.results.length; i += 1) {
        text += event.results[i][0].transcript + " ";
      }
      state.recognitionText = text;
      els.recognizedText.textContent = text.trim() || "正在听...";
    };
    state.recognition.onerror = () => {
      state.recognitionText = state.recognitionText || "";
    };
  }

  function startSpeechRecognition(targetText) {
    if (!state.recognitionAvailable || !state.recognition) return;
    try {
      state.recognition.lang = guessSpeechLang(targetText);
      state.recognition.start();
    } catch (error) {
      // Starting twice throws in Chromium; the current session can continue.
    }
  }

  function stopSpeechRecognition() {
    if (!state.recognitionAvailable || !state.recognition) return;
    try {
      state.recognition.stop();
    } catch (error) {
      // Recognition may already be stopped.
    }
  }

  function saveManualScore(value) {
    const segment = currentSegment();
    if (!segment) return;
    const latest = latestAttempt(segment.id);
    const attempt = latest || {
      id: `attempt-${Date.now()}`,
      segmentId: segment.id,
      at: Date.now(),
      duration: null,
      recognized: "",
      score: null,
      accuracy: null,
      pace: null,
      manual: null,
    };
    attempt.manual = value;
    if (!attempt.score) attempt.score = value * 20;
    saveAttempt(attempt, { replace: Boolean(latest && latest.id === attempt.id) });
    renderAll();
    toast(`自评分 ${value}`);
  }

  function scoreAttempt(target, spoken, targetDuration, spokenDuration) {
    const targetWords = tokenizeWords(target);
    const spokenWords = tokenizeWords(spoken);
    if (!targetWords.length || !spokenWords.length) {
      return { score: 0, accuracy: 0, pace: 0 };
    }
    const distance = levenshtein(targetWords, spokenWords);
    const accuracy = clamp((1 - distance / Math.max(targetWords.length, spokenWords.length)) * 100, 0, 100);
    const ratio = spokenDuration && targetDuration ? spokenDuration / Math.max(0.1, targetDuration) : 1;
    const pace = clamp(100 - Math.abs(1 - ratio) * 60, 0, 100);
    const score = Math.round(accuracy * 0.82 + pace * 0.18);
    return { score, accuracy, pace };
  }

  function tokenizeWords(text) {
    const normalized = normalizeText(text);
    if (!normalized) return [];
    if (/[\u4e00-\u9fff]/.test(normalized)) {
      return normalized.replace(/\s+/g, "").split("");
    }
    return normalized.split(/\s+/).filter(Boolean);
  }

  function normalizeText(text) {
    return text
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[“”]/g, '"')
      .replace(/[’']/g, "")
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function levenshtein(a, b) {
    const rows = a.length + 1;
    const cols = b.length + 1;
    const dp = Array.from({ length: rows }, () => Array(cols).fill(0));
    for (let i = 0; i < rows; i += 1) dp[i][0] = i;
    for (let j = 0; j < cols; j += 1) dp[0][j] = j;
    for (let i = 1; i < rows; i += 1) {
      for (let j = 1; j < cols; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      }
    }
    return dp[a.length][b.length];
  }

  function saveAttempt(attempt, options = {}) {
    const attempts = state.progress.attempts[attempt.segmentId] || [];
    if (options.replace) {
      const index = attempts.findIndex((item) => item.id === attempt.id);
      if (index >= 0) attempts[index] = attempt;
      else attempts.unshift(attempt);
    } else {
      attempts.unshift(attempt);
    }
    state.progress.attempts[attempt.segmentId] = attempts.slice(0, 20);
    state.progress.history = [
      attempt,
      ...state.progress.history.filter((item) => item.id !== attempt.id),
    ].slice(0, 80);
    persistProgress();
  }

  function latestAttempt(segmentId) {
    return (state.progress.attempts[segmentId] || [])[0] || null;
  }

  function isBookmarked(segmentId) {
    return Boolean(state.progress.bookmarks && state.progress.bookmarks[segmentId]);
  }

  function toggleBookmark(segmentId) {
    if (!segmentId) return;
    state.progress = normalizeProgress(state.progress);
    if (isBookmarked(segmentId)) {
      delete state.progress.bookmarks[segmentId];
      toast("已取消收藏");
    } else {
      state.progress.bookmarks[segmentId] = Date.now();
      toast("已收藏");
    }
    persistProgress();
    renderSegments();
    renderBookmarkButton();
  }

  function bestScore(segmentId) {
    const attempts = state.progress.attempts[segmentId] || [];
    return attempts.reduce((best, attempt) => Math.max(best, attempt.score || (attempt.manual ? attempt.manual * 20 : 0)), 0);
  }

  function collectStats() {
    let done = 0;
    let attempts = 0;
    let totalScore = 0;
    let scored = 0;
    for (const segment of state.segments) {
      const segmentAttempts = state.progress.attempts[segment.id] || [];
      attempts += segmentAttempts.length;
      const best = bestScore(segment.id);
      if (best >= DONE_SCORE) done += 1;
      if (best) {
        totalScore += best;
        scored += 1;
      }
    }
    return {
      done,
      attempts,
      scored,
      average: scored ? totalScore / scored : 0,
    };
  }

  function loadMaterialIndex() {
    try {
      const raw = localStorage.getItem(MATERIAL_INDEX_KEY);
      const saved = raw ? JSON.parse(raw) : [];
      state.materials = Array.isArray(saved)
        ? saved.filter((item) => item && item.id).slice(0, MAX_MATERIALS)
        : [];
    } catch (error) {
      state.materials = [];
    }
  }

  function persistMaterialIndex() {
    localStorage.setItem(MATERIAL_INDEX_KEY, JSON.stringify(state.materials.slice(0, MAX_MATERIALS)));
  }

  function persistActiveMaterial() {
    if (state.materialId) localStorage.setItem(ACTIVE_MATERIAL_KEY, state.materialId);
    else localStorage.removeItem(ACTIVE_MATERIAL_KEY);
  }

  function materialRecordKey(id) {
    return `${MATERIAL_RECORD_PREFIX}${id}`;
  }

  function upsertMaterialIndex(meta) {
    const existing = state.materials.find((item) => item.id === meta.id) || {};
    const next = {
      ...existing,
      ...meta,
      savedAt: existing.savedAt || meta.savedAt || Date.now(),
      updatedAt: meta.updatedAt || Date.now(),
    };
    state.materials = [
      next,
      ...state.materials.filter((item) => item.id !== meta.id),
    ].slice(0, MAX_MATERIALS);
    persistMaterialIndex();
    renderLibrary();
  }

  function updateActiveMaterialMeta(patch = {}) {
    if (!state.materialId) return;
    const index = state.materials.findIndex((item) => item.id === state.materialId);
    if (index < 0) return;
    state.materials[index] = {
      ...state.materials[index],
      selectedIndex: state.selectedIndex,
      practiceMode: state.practiceMode,
      ...patch,
      updatedAt: Date.now(),
    };
    persistMaterialIndex();
  }

  async function saveCurrentMaterial(options = {}) {
    if (!state.subtitleText && !options.mediaFile && !state.mediaName) return;
    if (!state.materialId) {
      state.materialId = state.fileId !== "empty"
        ? makeMaterialId(state.fileId)
        : makeMediaMaterialId(options.mediaFile);
    }

    try {
      const existing = await mediaDbRequest("readonly", (store) => store.get(materialRecordKey(state.materialId))).catch(() => null);
      const mediaFile = options.mediaFile || null;
      const now = Date.now();
      const record = {
        ...(existing || {}),
        id: state.materialId,
        fileId: state.fileId,
        subtitleName: state.fileName,
        subtitleText: state.subtitleText,
        segmentCount: state.segments.length,
        selectedIndex: state.selectedIndex,
        practiceMode: state.practiceMode,
        mediaName: mediaFile ? mediaFile.name : state.mediaName || existing?.mediaName || "",
        mediaType: mediaFile ? mediaFile.type : existing?.mediaType || "",
        mediaSize: mediaFile ? mediaFile.size : existing?.mediaSize || 0,
        mediaLastModified: mediaFile ? mediaFile.lastModified : existing?.mediaLastModified || 0,
        savedAt: existing?.savedAt || now,
        updatedAt: now,
      };
      if (mediaFile) record.blob = mediaFile;
      await mediaDbRequest("readwrite", (store) => store.put(record, materialRecordKey(record.id)));
      upsertMaterialIndex({
        id: record.id,
        fileId: record.fileId,
        subtitleName: record.subtitleName,
        mediaName: record.mediaName,
        segmentCount: record.segmentCount,
        selectedIndex: record.selectedIndex,
        practiceMode: record.practiceMode,
        savedAt: record.savedAt,
        updatedAt: record.updatedAt,
      });
      persistActiveMaterial();
      persistLastSession();
    } catch (error) {
      toast(isQuotaError(error) ? "素材太大，无法保存记录" : "素材记录保存失败");
    }
  }

  async function loadMaterial(id, options = {}) {
    if (!id) return;
    try {
      const record = await mediaDbRequest("readonly", (store) => store.get(materialRecordKey(id)));
      const meta = state.materials.find((item) => item.id === id) || {};
      if (!record) {
        toast("没有找到这条素材记录");
        return;
      }
      applyMaterialRecord(record, meta);
      if (!options.silent) toast(`已切换到 ${record.subtitleName || record.mediaName || "素材记录"}`);
    } catch (error) {
      toast("素材记录读取失败");
    }
  }

  async function deleteMaterial(id) {
    if (!id) return;
    const material = state.materials.find((item) => item.id === id);
    const title = material?.subtitleName || material?.mediaName || "这条素材";
    const confirmed = window.confirm(`删除「${title}」？\n字幕、媒体缓存、练习进度和录音都会一起删除。`);
    if (!confirmed) return;

    const wasActive = id === state.materialId;
    const currentIndex = state.materials.findIndex((item) => item.id === id);
    const nextMaterial = wasActive
      ? state.materials[currentIndex + 1] || state.materials[currentIndex - 1] || null
      : null;
    const record = await mediaDbRequest("readonly", (store) => store.get(materialRecordKey(id))).catch(() => null);
    deleteProgressForFile(record?.fileId || material?.fileId);

    state.materials = state.materials.filter((item) => item.id !== id);
    persistMaterialIndex();

    try {
      await mediaDbRequest("readwrite", (store) => store.delete(materialRecordKey(id)));
      toast("已删除素材记录");
    } catch (error) {
      toast("已删除列表记录，缓存清理失败");
    }

    if (wasActive && nextMaterial) {
      await loadMaterial(nextMaterial.id, { silent: true });
    } else if (wasActive) {
      resetCurrentMaterial();
    } else {
      renderLibrary();
    }
  }

  function resetCurrentMaterial() {
    cancelRecording();
    stopLoop({ silent: true });
    stopAttemptPlayback({ silent: true });
    clearMedia();
    state.fileId = "empty";
    state.materialId = "";
    state.fileName = "";
    state.subtitleText = "";
    state.rawEntries = [];
    state.segments = [];
    state.selectedIndex = 0;
    state.practiceMode = "listen";
    state.filter = "all";
    state.search = "";
    state.progress = defaultProgress();
    els.searchInput.value = "";
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.filter === state.filter);
    });
    localStorage.removeItem(LAST_SESSION_KEY);
    persistActiveMaterial();
    renderAll();
  }

  function cancelRecording() {
    if (!state.isRecording && !state.recorder && !state.activeStream) return;
    if (state.recorder && state.recorder.state !== "inactive") {
      state.recorder.ondataavailable = null;
      state.recorder.onstop = null;
      try {
        state.recorder.stop();
      } catch (error) {
        // The recorder can already be stopping in some browsers.
      }
    }
    stopSpeechRecognition();
    stopActiveStream();
    state.recorder = null;
    state.recordedChunks = [];
    state.isRecording = false;
    els.recordButton.classList.remove("recording");
    els.recordButton.innerHTML = '<svg><use href="#icon-mic"></use></svg>';
  }

  function applyMaterialRecord(record, meta = {}) {
    stopLoop({ silent: true });
    stopAttemptPlayback({ silent: true });
    state.materialId = record.id || meta.id || "";
    state.fileName = record.subtitleName || "";
    state.fileId = record.fileId || "empty";
    state.subtitleText = record.subtitleText || "";
    state.rawEntries = [];
    state.segments = [];
    if (state.subtitleText) {
      state.rawEntries = parseSrt(state.subtitleText);
      state.segments = segmentEntries(state.rawEntries);
    }
    state.selectedIndex = clamp(Number(meta.selectedIndex ?? record.selectedIndex) || 0, 0, Math.max(0, state.segments.length - 1));
    state.practiceMode = "listen";
    state.search = "";
    els.searchInput.value = "";
    loadProgress();
    if (record.blob) {
      loadMediaBlob(record.blob, {
        name: record.mediaName,
        type: record.mediaType,
        size: record.mediaSize,
        lastModified: record.mediaLastModified,
      });
    } else {
      clearMedia();
    }
    persistActiveMaterial();
    persistLastSession();
    updateActiveMaterialMeta();
    closeLibrary();
    renderAll();
  }

  function loadProgress() {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + state.fileId);
      state.progress = normalizeProgress(raw ? JSON.parse(raw) : null);
    } catch (error) {
      state.progress = defaultProgress();
    }
  }

  function deleteProgressForFile(fileId) {
    if (!fileId || fileId === "empty") return;
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + fileId);
      const progress = normalizeProgress(raw ? JSON.parse(raw) : null);
      deleteRecordingsForProgress(progress);
    } catch (error) {
      // Progress cleanup should not block deleting the material record.
    }
    localStorage.removeItem(STORAGE_PREFIX + fileId);
  }

  function persistProgress() {
    state.progress = normalizeProgress(state.progress);
    localStorage.setItem(STORAGE_PREFIX + state.fileId, JSON.stringify(state.progress));
  }

  function defaultProgress() {
    return { attempts: {}, history: [], bookmarks: {} };
  }

  function normalizeProgress(progress) {
    return {
      attempts: progress && progress.attempts && typeof progress.attempts === "object" ? progress.attempts : {},
      history: progress && Array.isArray(progress.history) ? progress.history : [],
      bookmarks: progress && progress.bookmarks && typeof progress.bookmarks === "object" ? progress.bookmarks : {},
    };
  }

  function restoreLastSession() {
    try {
      const raw = localStorage.getItem(LAST_SESSION_KEY);
      const saved = raw ? JSON.parse(raw) : null;
      if (!saved || !saved.text || !saved.name || !saved.fileId) return;

      const entries = parseSrt(saved.text);
      if (!entries.length) {
        localStorage.removeItem(LAST_SESSION_KEY);
        return;
      }

      state.fileName = saved.name;
      state.fileId = saved.fileId;
      state.materialId = saved.materialId || "";
      state.subtitleText = saved.text;
      state.rawEntries = entries;
      state.segments = segmentEntries(entries);
      state.selectedIndex = clamp(Number(saved.selectedIndex) || 0, 0, Math.max(0, state.segments.length - 1));
      state.practiceMode = "listen";
      state.restoredSession = true;
    } catch (error) {
      localStorage.removeItem(LAST_SESSION_KEY);
    }
  }

  function persistLastSession() {
    persistActiveMaterial();
    updateActiveMaterialMeta();
    if (!state.subtitleText || !state.segments.length) {
      localStorage.removeItem(LAST_SESSION_KEY);
      return;
    }
    try {
      localStorage.setItem(
        LAST_SESSION_KEY,
        JSON.stringify({
          version: 1,
          materialId: state.materialId,
          name: state.fileName,
          fileId: state.fileId,
          text: state.subtitleText,
          selectedIndex: state.selectedIndex,
          practiceMode: state.practiceMode,
          savedAt: Date.now(),
        })
      );
    } catch (error) {
      toast("字幕太大，刷新后可能无法恢复");
    }
  }

  async function restoreInitialMaterial() {
    if (state.segments.length) {
      await restoreCachedMedia();
      return;
    }

    const activeId = localStorage.getItem(ACTIVE_MATERIAL_KEY) || state.materials[0]?.id;
    if (activeId) {
      await loadMaterial(activeId, { silent: true });
      return;
    }

    await restoreCachedMedia();
  }

  async function restoreCachedMedia() {
    try {
      if (state.materialId) {
        const material = await mediaDbRequest("readonly", (store) => store.get(materialRecordKey(state.materialId)));
        if (material && material.blob) {
          loadMediaBlob(material.blob, {
            name: material.mediaName,
            type: material.mediaType,
            size: material.mediaSize,
            lastModified: material.mediaLastModified,
          });
          return;
        }
        return;
      }
      const record = await mediaDbRequest("readonly", (store) => store.get(LAST_MEDIA_KEY));
      if (!record || !record.blob) return;
      loadMediaBlob(record.blob, record);
      toast(`已恢复媒体${record.name ? `: ${record.name}` : ""}`);
    } catch (error) {
      // Media caching is a convenience layer; SRT practice still works without it.
    }
  }

  async function cacheMediaFile(file, options = {}) {
    if (!file || !window.indexedDB) return;
    try {
      await mediaDbRequest("readwrite", (store) =>
        store.put(
          {
            name: file.name,
            type: file.type,
            size: file.size,
            lastModified: file.lastModified,
            savedAt: Date.now(),
            blob: file,
          },
          LAST_MEDIA_KEY
        )
      );
      if (!options.silentSuccess) toast("媒体已缓存，刷新后可恢复");
    } catch (error) {
      toast(isQuotaError(error) ? "媒体太大，无法自动恢复" : "媒体缓存不可用");
    }
  }

  function mediaDbRequest(mode, action) {
    return dbStoreRequest(MEDIA_STORE_NAME, mode, action);
  }

  function recordingDbRequest(mode, action) {
    return dbStoreRequest(RECORDING_STORE_NAME, mode, action);
  }

  function dbStoreRequest(storeName, mode, action) {
    return openMediaDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const transaction = db.transaction(storeName, mode);
          let result;
          const request = action(transaction.objectStore(storeName));
          request.onsuccess = () => {
            result = request.result;
          };
          request.onerror = () => reject(request.error || new Error("Media cache request failed"));
          transaction.oncomplete = () => {
            db.close();
            resolve(result);
          };
          transaction.onerror = () => {
            db.close();
            reject(transaction.error || request.error || new Error("Media cache transaction failed"));
          };
          transaction.onabort = () => {
            db.close();
            reject(transaction.error || request.error || new Error("Media cache transaction aborted"));
          };
        })
    );
  }

  function openMediaDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("IndexedDB unavailable"));
        return;
      }

      const request = window.indexedDB.open(MEDIA_DB_NAME, MEDIA_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(MEDIA_STORE_NAME)) {
          db.createObjectStore(MEDIA_STORE_NAME);
        }
        if (!db.objectStoreNames.contains(RECORDING_STORE_NAME)) {
          db.createObjectStore(RECORDING_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Media cache open failed"));
      request.onblocked = () => reject(new Error("Media cache blocked"));
    });
  }

  function isQuotaError(error) {
    return error && (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED");
  }

  function exportProgress() {
    const payload = {
      fileName: state.fileName,
      exportedAt: new Date().toISOString(),
      segments: state.segments,
      progress: state.progress,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${state.fileName || "shadow-lab"}-progress.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast("进度已导出");
  }

  function resetProgress() {
    if (!state.segments.length) return;
    stopAttemptPlayback({ silent: true });
    const bookmarks = { ...(state.progress.bookmarks || {}) };
    deleteRecordingsForProgress(state.progress);
    localStorage.removeItem(STORAGE_PREFIX + state.fileId);
    state.progress = { ...defaultProgress(), bookmarks };
    if (Object.keys(bookmarks).length) persistProgress();
    renderAll();
    toast("进度已重置");
  }

  function deleteRecordingsForProgress(progress) {
    const ids = new Set();
    Object.values(progress.attempts || {}).flat().forEach((attempt) => {
      if (attempt.audioId) ids.add(attempt.audioId);
    });
    if (!ids.size) return;
    recordingDbRequest("readwrite", (store) => {
      let request = null;
      ids.forEach((id) => {
        request = store.delete(id);
      });
      return request || store.get("__noop__");
    }).catch(() => {
      // Stale recording blobs are harmless and should not block progress reset.
    });
  }

  function makeFileId(name, text) {
    let hash = 2166136261;
    const sample = `${name}:${text.length}:${text.slice(0, 2000)}:${text.slice(-2000)}`;
    for (let i = 0; i < sample.length; i += 1) {
      hash ^= sample.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `${name.replace(/[^\w.-]+/g, "_")}:${(hash >>> 0).toString(16)}`;
  }

  function makeMaterialId(seed) {
    return `mat:${String(seed || Date.now()).replace(/[^\w.-]+/g, "_")}`;
  }

  function makeMediaMaterialId(file) {
    if (!file) return makeMaterialId(`media:${Date.now()}`);
    return makeMaterialId(`media:${file.name}:${file.size}:${file.lastModified}`);
  }

  function formatLibraryTime(value) {
    const time = Number(value);
    if (!time) return "";
    const date = new Date(time);
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    return sameDay
      ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : date.toLocaleDateString();
  }

  function guessSpeechLang(text) {
    return /[\u4e00-\u9fff]/.test(text) ? "zh-CN" : "en-US";
  }

  function formatTime(seconds) {
    const safe = Math.max(0, seconds || 0);
    const mins = Math.floor(safe / 60);
    const secs = Math.floor(safe % 60);
    const millis = Math.round((safe % 1) * 1000);
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
  }

  function wait(ms) {
    return new Promise((resolve) => {
      state.loopTimer = setTimeout(resolve, ms);
    });
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function toast(message) {
    if (message) console.info(`[Shadow Lab] ${message}`);
  }

  window.ShadowLabCore = {
    parseSrt,
    parseTimestamp,
    segmentEntries,
    normalizeText,
    tokenizeWords,
    levenshtein,
    scoreAttempt,
    formatTime,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
