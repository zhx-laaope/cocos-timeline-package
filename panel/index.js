// UI Timeline Editor - 主逻辑
'use strict';

const Fs = require('fs');
const Path = require('path');
const Electron = require('electron');

const TIMELINE_CONFIGS_URL = 'db://assets/Script/Timeline/configs';
const TIMELINE_CONFIGS_FS = Path.join(Editor.Project.path, 'assets/Script/Timeline/configs');
const TIMELINE_COMPONENT_SCRIPT_UUID = '2c738156-8dbd-4360-92da-d98be89efcbd';
const PREFAB_CONTEXT_POLL_INTERVAL = 1000;
const PREFAB_NAME_CACHE = Object.create(null);

// 编辑器状态
let editorState = {
	timelineData: null,
	currentFile: null,
	prefabContext: null,
	contextKey: '',
	isTimelineEditable: false,
	selectedTrack: null,
	selectedClip: null,
	isPlaying: false,
	currentTime: 0,
	zoom: 100, // 缩放百分比
	pixelsPerSecond: 100, // 每秒对应的像素数
	isDirty: false,
	statusTimer: null,
};

function ensureDirectory(filePath) {
	const dir = Path.dirname(filePath);
	if (!Fs.existsSync(dir)) {
		Fs.mkdirSync(dir, { recursive: true });
	}
}

function refreshAsset(filePath) {
	if (!Editor.assetdb) return;
	try {
		let url = '';
		if (typeof Editor.assetdb.fspathToUrl === 'function') {
			url = Editor.assetdb.fspathToUrl(filePath);
		}
		if (url && typeof Editor.assetdb.refresh === 'function') {
			Editor.assetdb.refresh(url);
		}
	} catch (err) {
		Editor.warn('[UI Timeline Editor] 刷新资源失败:', err && err.message ? err.message : err);
	}
}

function dbUrlToFspath(url) {
	if (!url || !/^db:\/\/assets\//i.test(url)) return '';
	const relative = url.replace(/^db:\/\/assets\//i, '');
	return Path.join(Editor.Project.path, 'assets', relative);
}

function fspathToDbUrl(filePath) {
	if (!filePath) return '';
	const assetsRoot = Path.join(Editor.Project.path, 'assets') + Path.sep;
	if (filePath.indexOf(assetsRoot) !== 0) return '';
	return 'db://assets/' + filePath.slice(assetsRoot.length).split(Path.sep).join('/');
}

function urlToFspath(url) {
	if (!url) return '';
	if (!Editor.assetdb || typeof Editor.assetdb.urlToFspath !== 'function') return dbUrlToFspath(url);
	try {
		return Editor.assetdb.urlToFspath(url) || dbUrlToFspath(url);
	} catch (err) {
		return dbUrlToFspath(url);
	}
}

function uuidToUrl(uuid) {
	if (!uuid || !Editor.assetdb || typeof Editor.assetdb.uuidToUrl !== 'function') return '';

	const candidates = [];
	candidates.push(uuid);

	try {
		if (Editor.Utils && Editor.Utils.UuidUtils && Editor.Utils.UuidUtils.decompressUuid) {
			const normalized = Editor.Utils.UuidUtils.decompressUuid(uuid);
			if (normalized && normalized !== uuid) {
				candidates.push(normalized);
			}
		}
	} catch (err) {
		// Keep the original uuid candidate.
	}

	for (const candidate of candidates) {
		try {
			const url = Editor.assetdb.uuidToUrl(candidate);
			if (url) return url;
		} catch (err) {
			// Try the next candidate.
		}
	}
	return '';
}

function fspathToUrl(filePath) {
	if (!filePath) return '';
	if (!Editor.assetdb || typeof Editor.assetdb.fspathToUrl !== 'function') return fspathToDbUrl(filePath);
	try {
		return Editor.assetdb.fspathToUrl(filePath) || fspathToDbUrl(filePath);
	} catch (err) {
		return fspathToDbUrl(filePath);
	}
}

function readMetaUuid(filePath) {
	if (!filePath) return '';
	try {
		const meta = JSON.parse(Fs.readFileSync(filePath + '.meta', 'utf8'));
		return meta.uuid || '';
	} catch (err) {
		return '';
	}
}

function assetUrlExists(url) {
	const filePath = urlToFspath(url);
	return !!filePath && Fs.existsSync(filePath);
}

function getPrefabDefaultTimelineUrl(prefabUrl) {
	const name = Path.basename(prefabUrl || 'timeline', '.prefab');
	return TIMELINE_CONFIGS_URL + '/' + name + '.json';
}

function getPrefabDefaultTimelinePath(prefabUrl) {
	const url = getPrefabDefaultTimelineUrl(prefabUrl);
	return urlToFspath(url) || Path.join(TIMELINE_CONFIGS_FS, Path.basename(url));
}

function isTimelineComponentObject(item) {
	if (!item || typeof item !== 'object') return false;

	const type = item.__type__ || '';
	if (type === TIMELINE_COMPONENT_SCRIPT_UUID || /TimelineComponent/.test(type)) {
		return true;
	}

	return !!item.node
		&& Object.prototype.hasOwnProperty.call(item, 'timelineAsset')
		&& Object.prototype.hasOwnProperty.call(item, 'autoPlay')
		&& Object.prototype.hasOwnProperty.call(item, 'loopMode')
		&& Object.prototype.hasOwnProperty.call(item, 'speed');
}

function getAssetUuid(ref) {
	if (!ref) return '';
	if (typeof ref === 'string') return ref;
	if (typeof ref.__uuid__ === 'string') return ref.__uuid__;
	if (typeof ref.uuid === 'string') return ref.uuid;
	return '';
}

function findTimelineAssetFromPrefab(prefabPath) {
	if (!prefabPath || !Fs.existsSync(prefabPath)) return null;

	let prefabData = null;
	try {
		prefabData = JSON.parse(Fs.readFileSync(prefabPath, 'utf8'));
	} catch (err) {
		return null;
	}

	if (!Array.isArray(prefabData)) return null;

	for (const item of prefabData) {
		if (!isTimelineComponentObject(item)) continue;

		const uuid = getAssetUuid(item.timelineAsset || item._timelineAsset || item._N$timelineAsset);
		if (!uuid) continue;

		const url = uuidToUrl(uuid);
		if (!url || !/\.json$/i.test(url)) continue;

		const filePath = urlToFspath(url);
		if (filePath && Fs.existsSync(filePath)) {
			return {
				url,
				filePath,
				source: 'component',
			};
		}
	}

	return null;
}

function resolveTimelineForPrefab(prefabUrl) {
	const prefabPath = urlToFspath(prefabUrl);
	const componentTimeline = findTimelineAssetFromPrefab(prefabPath);
	if (componentTimeline) return componentTimeline;

	const fallbackUrl = getPrefabDefaultTimelineUrl(prefabUrl);
	if (assetUrlExists(fallbackUrl)) {
		return {
			url: fallbackUrl,
			filePath: getPrefabDefaultTimelinePath(prefabUrl),
			source: 'same-name',
		};
	}

	return {
		url: fallbackUrl,
		filePath: getPrefabDefaultTimelinePath(prefabUrl),
		source: 'missing',
		missing: true,
	};
}

function uuidToPrefab(uuid) {
	const url = uuidToUrl(uuid);
	if (!url || !/\.prefab$/i.test(url)) return null;
	return { uuid, url };
}

function getSelectedPrefab(rootName) {
	const selection = Editor.Selection && Editor.Selection.curSelection
		? Editor.Selection.curSelection('asset')
		: [];

	for (const uuid of selection || []) {
		const prefab = uuidToPrefab(uuid);
		if (!prefab) continue;

		const name = Path.basename(prefab.url, '.prefab');
		if (!rootName || name === rootName || selection.length === 1) {
			return prefab;
		}
	}
	return null;
}

function findPrefabByRootName(rootName) {
	if (!rootName) return null;
	if (Object.prototype.hasOwnProperty.call(PREFAB_NAME_CACHE, rootName)) {
		return PREFAB_NAME_CACHE[rootName];
	}

	const assetsRoot = Path.join(Editor.Project.path, 'assets');
	const targetFile = rootName + '.prefab';
	const matches = [];

	function walk(dir) {
		let entries = [];
		try {
			entries = Fs.readdirSync(dir, { withFileTypes: true });
		} catch (err) {
			return;
		}

		for (const entry of entries) {
			const full = Path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === '.git' || entry.name === 'node_modules') continue;
				walk(full);
				continue;
			}

			if (entry.isFile() && entry.name === targetFile) {
				matches.push(full);
			}
		}
	}

	walk(assetsRoot);
	if (matches.length !== 1) {
		PREFAB_NAME_CACHE[rootName] = null;
		return null;
	}

	const prefab = {
		uuid: readMetaUuid(matches[0]),
		url: fspathToUrl(matches[0]),
	};
	PREFAB_NAME_CACHE[rootName] = prefab.url ? prefab : null;
	return PREFAB_NAME_CACHE[rootName];
}

function resolvePrefabByRootName(rootName) {
	return getSelectedPrefab(rootName) || findPrefabByRootName(rootName);
}

function getAssetUrlFromWindowTitle() {
	try {
		const currentWindow = Electron.remote && Electron.remote.getCurrentWindow
			? Electron.remote.getCurrentWindow()
			: null;
		const title = currentWindow && currentWindow.getTitle ? currentWindow.getTitle() : '';
		const start = title.indexOf('db://');
		if (start === -1) return '';
		const match = title.slice(start).match(/^(db:\/\/.*?\.(?:fire|prefab))/i);
		return match ? match[1] : '';
	} catch (err) {
		return '';
	}
}

function getPrefabUrlFromWindowTitle() {
	const assetUrl = getAssetUrlFromWindowTitle();
	return /\.prefab$/i.test(assetUrl) ? assetUrl : '';
}

function resolvePrefabFromUrl(prefabUrl) {
	if (!prefabUrl || !/\.prefab$/i.test(prefabUrl)) return null;
	return {
		uuid: readMetaUuid(urlToFspath(prefabUrl)),
		url: prefabUrl,
	};
}

function getPrefabRootFromHierarchy(hierarchy, options) {
	if (!hierarchy) {
		return null;
	}

	const allowLooseNameMatch = !!(options && options.allowLooseNameMatch);

	if (Array.isArray(hierarchy)) {
		if (!allowLooseNameMatch && hierarchy.length !== 1) return null;
		return hierarchy.find((child) => child && child.name && resolvePrefabByRootName(child.name)) || null;
	}

	if (hierarchy.name === 'New Node' && Array.isArray(hierarchy.children)) {
		return hierarchy.children.find((child) => child && child.name && child.name !== 'gizmoRoot') || null;
	}

	if (allowLooseNameMatch && hierarchy.name && resolvePrefabByRootName(hierarchy.name)) {
		return hierarchy;
	}

	if (allowLooseNameMatch && Array.isArray(hierarchy.children)) {
		return hierarchy.children.find((child) => child && child.name && resolvePrefabByRootName(child.name)) || null;
	}

	return null;
}

// 初始化编辑器
Editor.Panel.extend({
	style: Fs.readFileSync(Editor.url('packages://ui-timeline-editor/panel/style.css', 'utf8')) + '',
	template: Fs.readFileSync(Editor.url('packages://ui-timeline-editor/panel/index.html', 'utf8')) + '',

	ready() {
		// 初始化
		this.initializeEditor();
		this.bindEvents();
		this.createEmptyTimeline();
		this.setTimelineEditable(false, '请打开 Prefab 后编辑 Timeline', 'Timeline 会自动绑定到当前 Prefab');
		this.startPrefabContextWatcher();
	},

	initializeEditor() {
		// 初始化编辑器状态
		editorState = {
			timelineData: null,
			currentFile: null,
			prefabContext: null,
			contextKey: '',
			isTimelineEditable: false,
			selectedTrack: null,
			selectedClip: null,
			isPlaying: false,
			currentTime: 0,
			zoom: 100,
			pixelsPerSecond: 100,
			isDirty: false,
			statusTimer: null,
		};

		this.updatePixelsPerSecond();
	},

	close() {
		this.stopPrefabContextWatcher();
		this.stopPlayback();
		if (editorState.statusTimer) {
			clearTimeout(editorState.statusTimer);
			editorState.statusTimer = null;
		}
	},

	bindEvents() {
		// 工具栏按钮
		this.$el('#btnNew').addEventListener('click', () => this.onNewTimeline());
		this.$el('#btnOpen').addEventListener('click', () => this.onOpenTimeline());
		this.$el('#btnSave').addEventListener('click', () => this.onSaveTimeline());
		this.$el('#btnSaveAs').addEventListener('click', () => this.onSaveAsTimeline());

		// 播放控制
		this.$el('#btnPlayPause').addEventListener('click', () => this.onPlayPause());
		this.$el('#btnStop').addEventListener('click', () => this.onStop());
		this.$el('#btnToStart').addEventListener('click', () => this.onSeekToStart());
		this.$el('#btnToEnd').addEventListener('click', () => this.onSeekToEnd());

		// 缩放控制
		this.$el('#btnZoomIn').addEventListener('click', () => this.onZoomIn());
		this.$el('#btnZoomOut').addEventListener('click', () => this.onZoomOut());

		// 添加轨道
		this.$el('#btnAddTrack').addEventListener('click', () => this.onAddTrack());
		this.$el('#btnAddTrackEmpty').addEventListener('click', () => this.onAddTrack());

		// Timeline 属性变化
		this.$el('#timelineName').addEventListener('input', (e) => this.onTimelinePropertyChange('name', e.target.value));
		this.$el('#timelineDuration').addEventListener('input', (e) => this.onTimelinePropertyChange('duration', parseFloat(e.target.value)));
		this.$el('#timelineFrameRate').addEventListener('input', (e) => this.onTimelinePropertyChange('frameRate', parseInt(e.target.value)));
		this.$el('#timelineLoopMode').addEventListener('change', (e) => this.onTimelinePropertyChange('loopMode', e.target.value));
		this.$el('#timelineAutoPlay').addEventListener('change', (e) => this.onTimelinePropertyChange('autoPlay', e.target.checked));

		// 对话框
		this.bindDialogEvents();

		// 片段类型按钮
		this.$$el('.clip-type-btn').forEach(btn => {
			btn.addEventListener('click', () => {
				const type = btn.getAttribute('data-type');
				this.onAddClip(type);
			});
		});

		// 时间轴点击
		const ruler = this.$el('#timelineRuler');
		ruler.addEventListener('click', (e) => this.onRulerClick(e));
	},

	bindDialogEvents() {
		// 关闭对话框
		this.$$el('.dialog-close').forEach(btn => {
			btn.addEventListener('click', (e) => {
				const dialogId = btn.getAttribute('data-dialog');
				this.closeDialog(dialogId);
			});
		});

		this.$$el('.dialog-footer .btn:not(.btn-primary)').forEach(btn => {
			btn.addEventListener('click', (e) => {
				const dialogId = btn.getAttribute('data-dialog');
				if (dialogId) this.closeDialog(dialogId);
			});
		});

		// 确认新建
		this.$el('#btnConfirmNew').addEventListener('click', () => this.onConfirmNew());

		// 确认添加轨道
		this.$el('#btnConfirmAddTrack').addEventListener('click', () => this.onConfirmAddTrack());
	},

	startPrefabContextWatcher() {
		this.checkPrefabContext(true);
		this.prefabContextTimer = setInterval(() => {
			this.checkPrefabContext(false);
		}, PREFAB_CONTEXT_POLL_INTERVAL);
	},

	stopPrefabContextWatcher() {
		if (this.prefabContextTimer) {
			clearInterval(this.prefabContextTimer);
			this.prefabContextTimer = null;
		}
	},

	checkPrefabContext(force) {
		if (this.isCheckingPrefabContext) return;
		this.isCheckingPrefabContext = true;
		const timeout = setTimeout(() => {
			this.isCheckingPrefabContext = false;
		}, 3000);

		this.queryPrefabContext((err, context) => {
			clearTimeout(timeout);
			this.isCheckingPrefabContext = false;

			if (err) {
				this.applyPrefabContext({
					inPrefab: false,
					reason: err.message || err,
				}, force);
				return;
			}

			this.applyPrefabContext(context || { inPrefab: false }, force);
		});
	},

	queryPrefabContext(callback) {
		const windowAssetUrl = getAssetUrlFromWindowTitle();
		const prefabUrl = getPrefabUrlFromWindowTitle();
		const titlePrefab = resolvePrefabFromUrl(prefabUrl);
		if (titlePrefab) {
			callback(null, {
				inPrefab: true,
				modeName: 'prefab',
				rootName: Path.basename(titlePrefab.url, '.prefab'),
				rootUuid: '',
				prefabUuid: titlePrefab.uuid || '',
				prefabUrl: titlePrefab.url,
			});
			return;
		}

		if (/\.fire$/i.test(windowAssetUrl)) {
			callback(null, {
				inPrefab: false,
				modeName: 'scene',
			});
			return;
		}

		Editor.Ipc.sendToPanel('scene', 'scene:query-hierarchy', (err, sceneId, hierarchy) => {
			if (err) {
				callback(null, {
					inPrefab: false,
					reason: err.message || err,
				});
				return;
			}

			const prefabRoot = getPrefabRootFromHierarchy(hierarchy, {
				allowLooseNameMatch: !windowAssetUrl,
			});
			if (!prefabRoot) {
				callback(null, {
					inPrefab: false,
					modeName: 'scene',
				});
				return;
			}

			const prefab = resolvePrefabByRootName(prefabRoot.name);
			if (!prefab) {
				callback(null, {
					inPrefab: true,
					modeName: 'prefab',
					rootName: prefabRoot.name || '',
					rootUuid: prefabRoot.id || prefabRoot.uuid || '',
					prefabUuid: '',
					prefabUrl: '',
					reason: '已进入 prefab 编辑态，但未能定位对应 prefab 资源',
				});
				return;
			}

			callback(null, {
				inPrefab: true,
				modeName: 'prefab',
				rootName: prefabRoot.name || '',
				rootUuid: prefabRoot.id || prefabRoot.uuid || '',
				prefabUuid: prefab.uuid || '',
				prefabUrl: prefab.url,
			});
		});
	},

	applyPrefabContext(context, force) {
		if (!context || !context.inPrefab) {
			if (force || editorState.contextKey) {
				this.closeCurrentTimeline(context && context.reason ? context.reason : 'Prefab 已关闭，Timeline 已关闭');
				editorState.prefabContext = null;
				editorState.contextKey = '';
				this.setTimelineEditable(false, '请打开 Prefab 后编辑 Timeline', 'Timeline 会自动绑定到当前 Prefab');
				this.updateUI();
			}
			return;
		}

		if (!context.prefabUrl) {
			const key = 'unresolved:' + (context.rootUuid || context.rootName || '');
			if (!force && editorState.contextKey === key) return;

			this.closeCurrentTimeline(context.reason || '无法定位当前 Prefab 资源');
			editorState.prefabContext = context;
			editorState.contextKey = key;
			this.setTimelineEditable(false, '无法定位当前 Prefab 资源', context.rootName || '');
			this.updateUI();
			return;
		}

		const timeline = resolveTimelineForPrefab(context.prefabUrl);
		const timelineState = timeline.missing ? 'missing' : 'ready';
		const contextKey = context.prefabUrl + '|' + timelineState + '|' + timeline.source + '|' + (timeline.filePath || timeline.url || '');
		if (!force && editorState.contextKey === contextKey) return;

		const nextContext = Object.assign({}, context, { timeline });

		if (timeline.missing) {
			this.closeCurrentTimeline('当前 Prefab 未找到配套 Timeline');
			editorState.prefabContext = nextContext;
			editorState.contextKey = contextKey;
			this.setTimelineEditable(false, '当前 Prefab 未找到配套 Timeline', Path.basename(context.prefabUrl) + ' -> ' + timeline.url);
			this.updateUI();
			return;
		}

		this.closeCurrentTimeline('切换 Prefab Timeline');
		editorState.prefabContext = nextContext;
		editorState.contextKey = contextKey;
		if (!this.loadTimelineFromFile(timeline.filePath, { silent: true })) {
			this.setTimelineEditable(false, 'Timeline 加载失败', timeline.filePath);
			this.updateUI();
			return;
		}
		this.setTimelineEditable(true, '正在编辑当前 Prefab 的 Timeline', context.prefabUrl);
		this.setStatus('已绑定: ' + Path.basename(context.prefabUrl) + ' -> ' + Path.basename(timeline.filePath), 'success');
	},

	closeCurrentTimeline(reason) {
		if (editorState.isDirty && editorState.currentFile) {
			const shouldSave = confirm('当前 Timeline 未保存，是否保存后关闭？');
			if (shouldSave) {
				this.saveTimelineToFile(editorState.currentFile, { skipContextGuard: true, silent: true });
			}
		}

		this.stopPlayback();
		editorState.currentFile = null;
		editorState.selectedTrack = null;
		editorState.selectedClip = null;
		editorState.currentTime = 0;
		editorState.isPlaying = false;
		editorState.isDirty = false;
		this.setPlayButtonIcon(false);
		this.createEmptyTimeline();
		if (reason) {
			this.setStatus(reason, 'info');
		}
	},

	// 创建空 Timeline
	createEmptyTimeline() {
		this.stopPlayback();
		editorState.selectedTrack = null;
		editorState.selectedClip = null;
		editorState.isPlaying = false;
		editorState.currentTime = 0;
		this.setPlayButtonIcon(false);

		editorState.timelineData = {
			name: 'new_timeline',
			version: '1.0.0',
			duration: 5.0,
			frameRate: 60,
			loopMode: 'none',
			autoPlay: false,
			tracks: [],
		};

		this.updateUI();
	},

	// 更新 UI
	updateUI() {
		if (!editorState.timelineData) return;

		const data = editorState.timelineData;

		// 更新属性面板
		this.$el('#timelineName').value = data.name || '';
		this.$el('#timelineDuration').value = data.duration || 5.0;
		this.$el('#timelineFrameRate').value = data.frameRate || 60;
		this.$el('#timelineLoopMode').value = data.loopMode || 'none';
		this.$el('#timelineAutoPlay').checked = data.autoPlay || false;

		// 更新文件信息
		this.$el('#fileName').textContent = editorState.currentFile ? Path.basename(editorState.currentFile) : '未保存';
		this.$el('#filePath').textContent = editorState.currentFile || '';

		// 更新时间显示
		this.$el('#totalTime').textContent = (data.duration || 5.0).toFixed(2);

		// 渲染时间轴
		this.renderTimeline();
		this.updateContextUI();
	},

	updateContextUI() {
		const context = editorState.prefabContext;
		const timeline = context && context.timeline;
		const hasFile = !!editorState.currentFile;

		this.$el('#fileName').textContent = hasFile
			? Path.basename(editorState.currentFile)
			: (context && context.prefabUrl ? Path.basename(context.prefabUrl, '.prefab') + ' 未绑定 Timeline' : '未打开 Prefab');
		this.$el('#filePath').textContent = hasFile
			? editorState.currentFile
			: (timeline && timeline.url ? timeline.url : '');

		this.setTimelineEditable(editorState.isTimelineEditable);
	},

	setTimelineEditable(enabled, title, detail) {
		editorState.isTimelineEditable = !!enabled;

		const root = this.$el('.timeline-editor');
		const overlay = this.$el('#contextOverlay');
		if (root) {
			root.classList.toggle('locked', !enabled);
		}

		if (overlay) {
			overlay.classList.toggle('hidden', !!enabled);
			const titleEl = this.$el('#contextTitle');
			const messageEl = this.$el('#contextMessage');
			if (titleEl && title) titleEl.textContent = title;
			if (messageEl && detail !== undefined) messageEl.textContent = detail || '';
		}

		this.$$el('input, select').forEach((el) => {
			el.disabled = !enabled;
		});

		const editButtons = [
			'#btnSave',
			'#btnPlayPause',
			'#btnStop',
			'#btnToStart',
			'#btnToEnd',
			'#btnZoomIn',
			'#btnZoomOut',
			'#btnAddTrack',
			'#btnAddTrackEmpty',
		];
		editButtons.forEach((selector) => {
			const el = this.$el(selector);
			if (el) el.disabled = !enabled;
		});

		this.$$el('.clip-type-btn').forEach((el) => {
			el.disabled = !enabled;
		});

		['#btnNew', '#btnOpen', '#btnSaveAs'].forEach((selector) => {
			const el = this.$el(selector);
			if (el) el.disabled = true;
		});
	},

	ensureTimelineEditable() {
		if (editorState.isTimelineEditable && editorState.prefabContext && editorState.currentFile) {
			return true;
		}

		this.setStatus('请先打开带有配套 Timeline 的 Prefab', 'error');
		return false;
	},

	// 渲染时间轴
	renderTimeline() {
		this.renderRuler();
		this.renderTracks();
		this.updatePlayhead();
	},

	// 渲染时间刻度尺
	renderRuler() {
		const ruler = this.$el('#timelineRuler');
		ruler.innerHTML = '';

		const duration = editorState.timelineData.duration || 5.0;
		const pps = editorState.pixelsPerSecond;
		const totalWidth = duration * pps;

		ruler.style.width = totalWidth + 'px';

		// 计算刻度间隔
		let interval = 1.0; // 默认 1 秒
		if (editorState.zoom < 50) {
			interval = 5.0;
		} else if (editorState.zoom < 100) {
			interval = 2.0;
		} else if (editorState.zoom > 200) {
			interval = 0.5;
		} else if (editorState.zoom > 400) {
			interval = 0.1;
		}

		// 绘制刻度
		for (let time = 0; time <= duration; time += interval) {
			const tick = document.createElement('div');
			tick.className = 'ruler-tick major';
			tick.style.left = (time * pps) + 'px';

			const label = document.createElement('span');
			label.className = 'ruler-label';
			label.textContent = time.toFixed(1) + 's';
			tick.appendChild(label);

			ruler.appendChild(tick);
		}
	},

	// 渲染轨道
	renderTracks() {
		const container = this.$el('#tracksContainer');
		const tracks = editorState.timelineData.tracks || [];

		if (tracks.length === 0) {
			container.innerHTML = `
				<div class="empty-timeline">
					<p>暂无轨道</p>
					<button id="btnAddTrackEmpty" class="btn btn-primary">添加轨道</button>
				</div>
			`;
			this.$el('#btnAddTrackEmpty').addEventListener('click', () => this.onAddTrack());
			this.renderTrackList();
			return;
		}

		container.innerHTML = '';

		tracks.forEach((track, index) => {
			const trackEl = this.createTrackElement(track, index);
			container.appendChild(trackEl);
		});

		// 更新轨道列表
		this.renderTrackList();
	},

	// 创建轨道元素
	createTrackElement(track, index) {
		const trackEl = document.createElement('div');
		trackEl.className = 'track';
		trackEl.dataset.trackIndex = index;

		if (editorState.selectedTrack === index) {
			trackEl.classList.add('selected');
		}

		// 轨道头部
		const header = document.createElement('div');
		header.className = 'track-header';
		header.innerHTML = `
			<div class="track-name">${track.name || 'Track ' + (index + 1)}</div>
			<div class="track-type">${track.type}</div>
			<div class="track-target">${track.targetPath || '.'}</div>
		`;
		header.addEventListener('click', () => this.onSelectTrack(index));

		// 轨道内容
		const content = document.createElement('div');
		content.className = 'track-content';
		content.style.width = (editorState.timelineData.duration * editorState.pixelsPerSecond) + 'px';

		// 渲染片段
		(track.clips || []).forEach((clip, clipIndex) => {
			const clipEl = this.createClipElement(clip, index, clipIndex);
			content.appendChild(clipEl);
		});

		trackEl.appendChild(header);
		trackEl.appendChild(content);

		return trackEl;
	},

	// 创建片段元素
	createClipElement(clip, trackIndex, clipIndex) {
		const clipEl = document.createElement('div');
		clipEl.className = 'clip';
		clipEl.dataset.trackIndex = trackIndex;
		clipEl.dataset.clipIndex = clipIndex;
		clipEl.dataset.type = editorState.timelineData.tracks[trackIndex].type;

		const pps = editorState.pixelsPerSecond;
		const left = clip.start * pps;
		const width = (clip.duration || 0.5) * pps;

		clipEl.style.left = left + 'px';
		clipEl.style.width = width + 'px';

		if (editorState.selectedTrack === trackIndex && editorState.selectedClip === clipIndex) {
			clipEl.classList.add('selected');
		}

		clipEl.innerHTML = `
			<div class="clip-name">${clip.name || 'Clip ' + (clipIndex + 1)}</div>
			<div class="clip-time">${clip.start.toFixed(2)}s - ${(clip.start + (clip.duration || 0)).toFixed(2)}s</div>
			<div class="clip-handle left"></div>
			<div class="clip-handle right"></div>
		`;

		// 点击选中
		clipEl.addEventListener('click', (e) => {
			e.stopPropagation();
			this.onSelectClip(trackIndex, clipIndex);
		});

		// 拖拽移动
		this.makeClipDraggable(clipEl, trackIndex, clipIndex);

		return clipEl;
	},

	// 使片段可拖拽
	makeClipDraggable(clipEl, trackIndex, clipIndex) {
		let isDragging = false;
		let startX = 0;
		let startLeft = 0;

		const onMouseDown = (e) => {
			if (e.target.classList.contains('clip-handle')) return;

			isDragging = true;
			startX = e.clientX;
			startLeft = parseFloat(clipEl.style.left);
			clipEl.classList.add('dragging');

			document.addEventListener('mousemove', onMouseMove);
			document.addEventListener('mouseup', onMouseUp);

			e.preventDefault();
		};

		const onMouseMove = (e) => {
			if (!isDragging) return;

			const deltaX = e.clientX - startX;
			const newLeft = Math.max(0, startLeft + deltaX);
			clipEl.style.left = newLeft + 'px';
		};

		const onMouseUp = (e) => {
			if (!isDragging) return;

			isDragging = false;
			clipEl.classList.remove('dragging');

			if (!this.ensureTimelineEditable()) {
				document.removeEventListener('mousemove', onMouseMove);
				document.removeEventListener('mouseup', onMouseUp);
				return;
			}

			// 更新数据
			const newStart = parseFloat(clipEl.style.left) / editorState.pixelsPerSecond;
			const clip = editorState.timelineData.tracks[trackIndex].clips[clipIndex];
			clip.start = Math.max(0, newStart);

			this.markDirty();
			this.renderTimeline();

			document.removeEventListener('mousemove', onMouseMove);
			document.removeEventListener('mouseup', onMouseUp);
		};

		clipEl.addEventListener('mousedown', onMouseDown);
	},

	// 渲染轨道列表
	renderTrackList() {
		const list = this.$el('#trackList');
		const tracks = editorState.timelineData.tracks || [];

		if (tracks.length === 0) {
			list.innerHTML = '<div class="empty-state">暂无轨道</div>';
			return;
		}

		list.innerHTML = '';

		tracks.forEach((track, index) => {
			const item = document.createElement('div');
			item.className = 'track-list-item';
			if (editorState.selectedTrack === index) {
				item.classList.add('selected');
			}

			item.innerHTML = `
				<div class="track-list-item-name">${track.name || 'Track ' + (index + 1)}</div>
				<div class="track-list-item-info">${track.type} - ${track.targetPath || '.'}</div>
			`;

			item.addEventListener('click', () => this.onSelectTrack(index));

			list.appendChild(item);
		});
	},

	// 更新播放头位置
	updatePlayhead() {
		const playhead = this.$el('#playhead');
		const pps = editorState.pixelsPerSecond;
		const left = 120 + (editorState.currentTime * pps);
		playhead.style.left = left + 'px';

		this.$el('#currentTime').textContent = editorState.currentTime.toFixed(2);
	},

	// 更新每秒像素数
	updatePixelsPerSecond() {
		editorState.pixelsPerSecond = 100 * (editorState.zoom / 100);
	},

	// 事件处理
	onNewTimeline() {
		this.setStatus('Timeline 由当前打开的 Prefab 自动绑定，不能手动新建', 'error');
	},

	onOpenTimeline() {
		this.setStatus('请打开 Prefab，插件会自动加载对应 Timeline', 'error');
	},

	onSaveTimeline() {
		if (!this.ensureTimelineEditable()) return;

		if (!editorState.currentFile) {
			this.setStatus('当前 Prefab 未绑定 Timeline 文件', 'error');
			return;
		}

		this.saveTimelineToFile(editorState.currentFile);
	},

	onSaveAsTimeline() {
		this.setStatus('Timeline 必须保存到当前 Prefab 绑定的文件，不能另存为', 'error');
	},

	onPlayPause() {
		if (!this.ensureTimelineEditable()) return;

		editorState.isPlaying = !editorState.isPlaying;

		this.setPlayButtonIcon(editorState.isPlaying);

		if (editorState.isPlaying) {
			this.startPlayback();
		} else {
			this.stopPlayback();
		}
	},

	onStop() {
		if (!this.ensureTimelineEditable()) return;

		editorState.isPlaying = false;
		editorState.currentTime = 0;

		this.setPlayButtonIcon(false);

		this.stopPlayback();
		this.updatePlayhead();
	},

	onSeekToStart() {
		if (!this.ensureTimelineEditable()) return;

		editorState.currentTime = 0;
		this.updatePlayhead();
	},

	onSeekToEnd() {
		if (!this.ensureTimelineEditable()) return;

		editorState.currentTime = editorState.timelineData.duration || 5.0;
		this.updatePlayhead();
	},

	onZoomIn() {
		if (!this.ensureTimelineEditable()) return;

		editorState.zoom = Math.min(400, editorState.zoom + 25);
		this.updatePixelsPerSecond();
		this.$el('#zoomLevel').textContent = editorState.zoom + '%';
		this.renderTimeline();
	},

	onZoomOut() {
		if (!this.ensureTimelineEditable()) return;

		editorState.zoom = Math.max(25, editorState.zoom - 25);
		this.updatePixelsPerSecond();
		this.$el('#zoomLevel').textContent = editorState.zoom + '%';
		this.renderTimeline();
	},

	onAddTrack() {
		if (!this.ensureTimelineEditable()) return;

		this.showDialog('dialogAddTrack');
	},

	onConfirmAddTrack() {
		if (!this.ensureTimelineEditable()) return;

		const type = this.$el('#newTrackType').value;
		const name = this.$el('#newTrackName').value || 'New Track';
		const targetPath = this.$el('#newTrackTarget').value || '.';

		const track = {
			id: 'track_' + Date.now(),
			name: name,
			type: type,
			targetPath: targetPath,
			enabled: true,
			clips: [],
		};

		editorState.timelineData.tracks.push(track);
		this.markDirty();
		this.renderTimeline();
		this.closeDialog('dialogAddTrack');

		// 清空输入
		this.$el('#newTrackName').value = '';
		this.$el('#newTrackTarget').value = '.';
	},

	onAddClip(type) {
		if (!this.ensureTimelineEditable()) return;

		if (editorState.selectedTrack === null) {
			this.setStatus('请先选择一个轨道', 'error');
			return;
		}

		const track = editorState.timelineData.tracks[editorState.selectedTrack];
		const clip = {
			id: 'clip_' + Date.now(),
			name: 'New Clip',
			start: editorState.currentTime,
			duration: 1.0,
			enabled: true,
		};

		// 根据类型添加特定字段
		switch (type) {
			case 'animation':
				clip.clipName = 'animation_name';
				clip.speed = 1.0;
				clip.loop = false;
				break;
			case 'spine':
				clip.animName = 'animation_name';
				clip.speed = 1.0;
				clip.loop = false;
				clip.trackIndex = 0;
				break;
			case 'tween':
				clip.props = { x: 0, y: 0 };
				clip.easing = 'linear';
				break;
			case 'code':
				clip.callbackName = 'callback';
				clip.params = [];
				break;
			case 'audio':
				clip.audioUrl = 'audio/sound';
				clip.volume = 1.0;
				clip.loop = false;
				break;
			case 'active':
				clip.active = true;
				break;
		}

		track.clips.push(clip);
		this.markDirty();
		this.renderTimeline();
		this.setStatus('已添加片段', 'success');
	},

	onSelectTrack(index) {
		if (!this.ensureTimelineEditable()) return;

		editorState.selectedTrack = index;
		editorState.selectedClip = null;
		this.renderTimeline();
		this.updateClipProperties();
	},

	onSelectClip(trackIndex, clipIndex) {
		if (!this.ensureTimelineEditable()) return;

		editorState.selectedTrack = trackIndex;
		editorState.selectedClip = clipIndex;
		this.renderTimeline();
		this.updateClipProperties();
	},

	onRulerClick(e) {
		if (!this.ensureTimelineEditable()) return;

		const rect = e.target.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const time = x / editorState.pixelsPerSecond;
		editorState.currentTime = Math.max(0, Math.min(time, editorState.timelineData.duration));
		this.updatePlayhead();
	},

	onTimelinePropertyChange(key, value) {
		if (!this.ensureTimelineEditable()) return;

		editorState.timelineData[key] = value;
		this.markDirty();

		if (key === 'duration') {
			this.renderTimeline();
		}
	},

	onConfirmNew() {
		this.closeDialog('dialogNew');
		this.setStatus('Timeline 由当前 Prefab 自动绑定，不能手动新建', 'error');
	},

	// 更新片段属性面板
	updateClipProperties() {
		const panel = this.$el('#clipProperties');

		if (editorState.selectedTrack === null || editorState.selectedClip === null) {
			panel.innerHTML = '<div class="empty-state">未选中片段</div>';
			return;
		}

		const track = editorState.timelineData.tracks[editorState.selectedTrack];
		if (!track || !track.clips || !track.clips[editorState.selectedClip]) {
			editorState.selectedTrack = null;
			editorState.selectedClip = null;
			panel.innerHTML = '<div class="empty-state">未选中片段</div>';
			return;
		}

		const clip = track.clips[editorState.selectedClip];

		// TODO: 根据片段类型显示不同的属性编辑器
		panel.innerHTML = `
			<div class="property-group">
				<label>片段名称</label>
				<input type="text" value="${clip.name || ''}" data-prop="name">
			</div>
			<div class="property-group">
				<label>开始时间（秒）</label>
				<input type="number" value="${clip.start}" step="0.1" data-prop="start">
			</div>
			<div class="property-group">
				<label>持续时间（秒）</label>
				<input type="number" value="${clip.duration || 0}" step="0.1" data-prop="duration">
			</div>
		`;

		// 绑定属性变化事件
		panel.querySelectorAll('input').forEach(input => {
			input.addEventListener('input', (e) => {
				if (!this.ensureTimelineEditable()) return;

				const prop = e.target.getAttribute('data-prop');
				let value = e.target.value;

				if (e.target.type === 'number') {
					value = parseFloat(value);
				}

				clip[prop] = value;
				this.markDirty();
				this.renderTimeline();
			});
		});
	},

	// 播放控制
	startPlayback() {
		if (this.playbackInterval) return;

		this.playbackInterval = setInterval(() => {
			editorState.currentTime += 0.016; // ~60fps

			if (editorState.currentTime >= editorState.timelineData.duration) {
				editorState.currentTime = 0;
			}

			this.updatePlayhead();
		}, 16);
	},

	stopPlayback() {
		if (this.playbackInterval) {
			clearInterval(this.playbackInterval);
			this.playbackInterval = null;
		}
	},

	setPlayButtonIcon(isPlaying) {
		const btn = this.$el('#btnPlayPause');
		if (!btn) return;
		const icon = btn.querySelector('.icon');
		if (icon) {
			icon.textContent = isPlaying ? '⏸' : '▶';
		}
	},

	// 文件操作
	loadTimelineFromFile(filePath, options = {}) {
		try {
			const content = Fs.readFileSync(filePath, 'utf8');
			const data = JSON.parse(content);

			this.stopPlayback();
			editorState.timelineData = data;
			editorState.currentFile = filePath;
			editorState.selectedTrack = null;
			editorState.selectedClip = null;
			editorState.currentTime = 0;
			editorState.isPlaying = false;
			editorState.isDirty = false;
			this.setPlayButtonIcon(false);

			this.updateUI();
			if (!options.silent) {
				this.setStatus('已加载: ' + Path.basename(filePath), 'success');
			}
			return true;
		} catch (err) {
			this.setStatus('加载失败: ' + err.message, 'error');
			return false;
		}
	},

	saveTimelineToFile(filePath, options = {}) {
		try {
			if (!options.skipContextGuard) {
				if (!this.ensureTimelineEditable()) return;

				const contextTimeline = editorState.prefabContext && editorState.prefabContext.timeline;
				if (!contextTimeline || Path.resolve(filePath) !== Path.resolve(contextTimeline.filePath)) {
					this.setStatus('只能保存当前 Prefab 绑定的 Timeline', 'error');
					return;
				}
			}

			const content = JSON.stringify(editorState.timelineData, null, 2);
			ensureDirectory(filePath);
			Fs.writeFileSync(filePath, content, 'utf8');
			refreshAsset(filePath);

			editorState.currentFile = filePath;
			editorState.isDirty = false;

			this.updateUI();
			if (!options.silent) {
				this.setStatus('已保存: ' + Path.basename(filePath), 'success');
			}
		} catch (err) {
			this.setStatus('保存失败: ' + err.message, 'error');
		}
	},

	// 工具方法
	markDirty() {
		editorState.isDirty = true;
	},

	setStatus(message, type = 'info', duration = 3000) {
		const statusEl = this.$el('#statusText');
		statusEl.textContent = message;
		statusEl.className = type || 'info';

		if (editorState.statusTimer) {
			clearTimeout(editorState.statusTimer);
			editorState.statusTimer = null;
		}

		if (!duration) return;

		// 3秒后恢复
		editorState.statusTimer = setTimeout(() => {
			statusEl.textContent = '就绪';
			statusEl.className = 'info';
			editorState.statusTimer = null;
		}, duration);
	},

	showDialog(dialogId) {
		this.$el('#' + dialogId).style.display = 'flex';
	},

	closeDialog(dialogId) {
		this.$el('#' + dialogId).style.display = 'none';
	},

	$el(selector) {
		return this.shadowRoot.querySelector(selector);
	},

	$$el(selector) {
		return this.shadowRoot.querySelectorAll(selector);
	},
});
