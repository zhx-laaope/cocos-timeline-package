// UI Timeline Editor - 主逻辑
'use strict';

const Fs = require('fs');
const Path = require('path');
const Electron = require('electron');

const TIMELINE_CONFIGS_URL = 'db://assets/Script/Timeline/configs';
const TIMELINE_CONFIGS_FS = Path.join(Editor.Project.path, 'assets/Script/Timeline/configs');
const TIMELINE_RUNTIME_URL = 'db://assets/Script/Timeline';
const TIMELINE_RUNTIME_FS = Path.join(Editor.Project.path, 'assets/Script/Timeline');
const TIMELINE_RUNTIME_MARKER = 'UI Timeline Runtime';
const RUNTIME_TEMPLATES = [
	{
		name: 'TimelinePlayer.ts',
		templateUrl: 'packages://ui-timeline-editor/templates/runtime/TimelinePlayer.ts',
		targetPath: Path.join(TIMELINE_RUNTIME_FS, 'TimelinePlayer.ts'),
	},
	{
		name: 'TimelineComponent.ts',
		templateUrl: 'packages://ui-timeline-editor/templates/runtime/TimelineComponent.ts',
		targetPath: Path.join(TIMELINE_RUNTIME_FS, 'TimelineComponent.ts'),
	},
];
const TIMELINE_COMPONENT_SCRIPT_PATH = Path.join(TIMELINE_RUNTIME_FS, 'TimelineComponent.ts');
const TIMELINE_COMPONENT_SCRIPT_UUID = '2c738156-8dbd-4360-92da-d98be89efcbd';
const PREFAB_CONTEXT_POLL_INTERVAL = 1000;
const TRACK_HEADER_WIDTH = 120;
const PREFAB_NAME_CACHE = Object.create(null);
const CLIP_TYPES = ['animation', 'spine', 'tween', 'code', 'audio', 'active'];

function isEditableEventTarget(target) {
	let node = target;
	while (node) {
		if (node.nodeType === 1) {
			const tagName = String(node.tagName || '').toUpperCase();
			if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
				return true;
			}
			if (node.isContentEditable) {
				return true;
			}
			if (typeof node.getAttribute === 'function') {
				const contentEditableValue = node.getAttribute('contenteditable');
				const role = String(node.getAttribute('role') || '').toLowerCase();
				const contentEditable = contentEditableValue === null ? null : String(contentEditableValue).toLowerCase();
				if (contentEditable === 'false') {
					return false;
				}
				if (contentEditable === 'true' || contentEditable === '') {
					return true;
				}
				if (role === 'textbox') {
					return true;
				}
			}
		}
		node = node.parentElement || node.parentNode;
	}
	return false;
}

function getDeepActiveElement(root) {
	let activeElement = root && root.activeElement;
	while (activeElement && activeElement.shadowRoot && activeElement.shadowRoot.activeElement) {
		activeElement = activeElement.shadowRoot.activeElement;
	}
	return activeElement || null;
}

function isEditableKeyboardEvent(event) {
	if (!event) return false;
	if (typeof event.composedPath === 'function') {
		const path = event.composedPath();
		if (Array.isArray(path) && path.some((target) => isEditableEventTarget(target))) {
			return true;
		}
	}
	const ownerDocument = event.target && event.target.ownerDocument
		? event.target.ownerDocument
		: (typeof document === 'undefined' ? null : document);
	if (isEditableEventTarget(getDeepActiveElement(ownerDocument))) {
		return true;
	}
	return isEditableEventTarget(event.target);
}

function createDefaultEditorState(overrides) {
	return Object.assign({
		timelineData: null,
		currentFile: null,
		prefabContext: null,
		contextKey: '',
		isTimelineEditable: false,
		selectedTrack: null,
		selectedClip: null,
		isPlaying: false,
		currentTime: 0,
		playbackDirection: 1,
		lastPlaybackTime: 0,
		zoom: 100, // 缩放百分比
		pixelsPerSecond: 100, // 每秒对应的像素数
		isDirty: false,
		statusTimer: null,
		history: [],
		historyIndex: -1,
		maxHistorySize: 50,
		clipboard: null,
		selectedClips: [], // [{trackIndex, clipIndex}]
		scenePreviewActive: false,
		scenePreviewInFlight: false,
		scenePreviewPending: null,
		scenePreviewLastWarning: '',
		snapEnabled: true,
		snapThreshold: 10, // 像素阈值
		snapToClips: true,
		snapToGrid: true,
		snapGuides: [], // 吸附辅助线
	}, overrides || {});
}

// 编辑器状态
let editorState = createDefaultEditorState();

function cloneData(value) {
	return JSON.parse(JSON.stringify(value));
}

function clampNumber(value, min, max, fallback) {
	const number = typeof value === 'number' ? value : parseFloat(value);
	if (!Number.isFinite(number)) return fallback;
	if (typeof min === 'number' && number < min) return min;
	if (typeof max === 'number' && number > max) return max;
	return number;
}

function escapeHtml(value) {
	return String(value === undefined || value === null ? '' : value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function formatTime(value) {
	return clampNumber(value, 0, null, 0).toFixed(2);
}

function stringifyJsonValue(value, fallback) {
	try {
		return JSON.stringify(value === undefined ? fallback : value, null, 2);
	} catch (err) {
		return JSON.stringify(fallback, null, 2);
	}
}

function createDefaultTimeline(name) {
	return {
		name: name || 'new_timeline',
		version: '1.0.0',
		duration: 5.0,
		frameRate: 60,
		loopMode: 'none',
		autoPlay: false,
		tracks: [],
	};
}

function createDefaultClip(type, start) {
	const clip = {
		id: 'clip_' + Date.now(),
		type: type || 'animation',
		name: 'New Clip',
		start: clampNumber(start, 0, null, 0),
		duration: 1.0,
		enabled: true,
	};

	switch (clip.type) {
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
			clip.from = null;
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

	return clip;
}

function getClipType(track, clip) {
	return (clip && clip.type) || (track && track.type) || 'animation';
}

function normalizeClip(rawClip, trackType, index) {
	const source = rawClip && typeof rawClip === 'object' ? rawClip : {};
	const type = source.type || trackType || 'animation';
	const defaults = createDefaultClip(type, 0);
	const clip = Object.assign(defaults, source);
	clip.id = source.id || ('clip_' + Date.now() + '_' + index);
	clip.type = type;
	clip.name = clip.name || 'Clip ' + (index + 1);
	clip.start = clampNumber(clip.start, 0, null, 0);
	clip.duration = clampNumber(clip.duration, 0.01, null, 1);
	clip.enabled = clip.enabled !== false;

	if (type === 'audio') {
		clip.volume = clampNumber(clip.volume, 0, 1, 1);
	}
	if (type === 'spine') {
		clip.trackIndex = Math.max(0, parseInt(clip.trackIndex, 10) || 0);
	}

	return clip;
}

function normalizeTrack(rawTrack, index) {
	const source = rawTrack && typeof rawTrack === 'object' ? rawTrack : {};
	const type = source.type || 'animation';
	const track = Object.assign({
		id: 'track_' + Date.now() + '_' + index,
		name: 'Track ' + (index + 1),
		type,
		targetPath: '.',
		enabled: true,
		locked: false,
		muted: false,
		clips: [],
	}, source);

	track.id = source.id || ('track_' + Date.now() + '_' + index);
	track.type = track.type || type;
	track.name = track.name || 'Track ' + (index + 1);
	track.targetPath = track.targetPath || '.';
	track.enabled = track.enabled !== false;
	track.locked = !!track.locked;
	track.muted = !!track.muted;
	track.clips = Array.isArray(track.clips)
		? track.clips.map((clip, clipIndex) => normalizeClip(clip, track.type, clipIndex))
		: [];

	return track;
}

function normalizeTimelineData(rawData, fallbackName) {
	const source = rawData && typeof rawData === 'object' ? rawData : {};
	const data = Object.assign(createDefaultTimeline(fallbackName), source);
	data.name = data.name || fallbackName || 'new_timeline';
	data.version = data.version || '1.0.0';
	data.duration = clampNumber(data.duration, 0.01, null, 5.0);
	data.frameRate = Math.max(1, parseInt(data.frameRate, 10) || 60);
	data.loopMode = ['none', 'loop', 'pingpong'].indexOf(data.loopMode) >= 0 ? data.loopMode : 'none';
	data.autoPlay = !!data.autoPlay;
	data.tracks = Array.isArray(data.tracks)
		? data.tracks.map((track, index) => normalizeTrack(track, index))
		: [];

	let maxEndTime = 0;
	data.tracks.forEach((track) => {
		track.clips.forEach((clip) => {
			maxEndTime = Math.max(maxEndTime, clip.start + clip.duration);
		});
	});
	data.duration = Math.max(data.duration, Math.ceil(maxEndTime * 100) / 100 || data.duration);

	return data;
}

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

function refreshAssetUrl(url) {
	if (!Editor.assetdb || !url || typeof Editor.assetdb.refresh !== 'function') return;
	try {
		Editor.assetdb.refresh(url);
	} catch (err) {
		Editor.warn('[UI Timeline Editor] 刷新资源失败:', err && err.message ? err.message : err);
	}
}

function readPackageTemplate(url) {
	return Fs.readFileSync(Editor.url(url, 'utf8'), 'utf8');
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

function compressUuid(uuid) {
	if (!uuid || typeof uuid !== 'string') return '';
	try {
		if (Editor.Utils && Editor.Utils.UuidUtils && Editor.Utils.UuidUtils.compressUuid) {
			return Editor.Utils.UuidUtils.compressUuid(uuid) || uuid;
		}
	} catch (err) {
		// Fall back to the raw uuid.
	}
	return uuid;
}

function getTimelineComponentScriptInfo() {
	const uuid = readMetaUuid(TIMELINE_COMPONENT_SCRIPT_PATH);
	if (!uuid) return null;
	return {
		uuid,
		typeId: compressUuid(uuid),
		path: TIMELINE_COMPONENT_SCRIPT_PATH,
		url: TIMELINE_RUNTIME_URL + '/TimelineComponent.ts',
	};
}

function getTimelineComponentTypeIds() {
	const ids = [TIMELINE_COMPONENT_SCRIPT_UUID];
	const info = getTimelineComponentScriptInfo();
	if (info) {
		ids.push(info.uuid);
		ids.push(info.typeId);
	}
	return ids.filter((item, index) => item && ids.indexOf(item) === index);
}

function isTimelineComponentType(type, typeIds) {
	if (!type || typeof type !== 'string') return false;
	if (/TimelineComponent/.test(type)) return true;
	return (typeIds || getTimelineComponentTypeIds()).indexOf(type) !== -1;
}

function getComponentAssetRefKey(component) {
	if (!component || typeof component !== 'object') return 'timelineAsset';
	if (Object.prototype.hasOwnProperty.call(component, 'timelineAsset')) return 'timelineAsset';
	if (Object.prototype.hasOwnProperty.call(component, '_timelineAsset')) return '_timelineAsset';
	if (Object.prototype.hasOwnProperty.call(component, '_N$timelineAsset')) return '_N$timelineAsset';
	return 'timelineAsset';
}

function loopModeToRuntimeEnum(loopMode) {
	if (loopMode === 'loop') return 1;
	if (loopMode === 'pingpong') return 2;
	return 0;
}

function createTimelineComponentObject(rootNodeIndex, componentTypeId, timelineAssetUuid, timelineData) {
	return {
		__type__: componentTypeId,
		_name: '',
		_objFlags: 0,
		node: {
			__id__: rootNodeIndex,
		},
		_enabled: true,
		timelineAsset: {
			__uuid__: timelineAssetUuid,
		},
		autoPlay: !!(timelineData && timelineData.autoPlay),
		loopMode: loopModeToRuntimeEnum(timelineData && timelineData.loopMode),
		speed: 1,
		_id: '',
	};
}

function bindTimelineComponentToPrefabData(prefabData, options) {
	if (!Array.isArray(prefabData)) {
		throw new Error('Prefab 数据格式无效');
	}
	if (!options || !options.componentTypeId) {
		throw new Error('缺少 TimelineComponent 脚本类型');
	}
	if (!options.timelineAssetUuid) {
		throw new Error('缺少 Timeline JSON 资源 UUID');
	}

	const prefab = prefabData[0];
	const rootNodeIndex = prefab && prefab.data && typeof prefab.data.__id__ === 'number'
		? prefab.data.__id__
		: 1;
	const rootNode = prefabData[rootNodeIndex];
	if (!rootNode || rootNode.__type__ !== 'cc.Node') {
		throw new Error('未找到 Prefab 根节点');
	}

	if (!Array.isArray(rootNode._components)) {
		rootNode._components = [];
	}

	const typeIds = options.typeIds || [options.componentTypeId];
	let componentIndex = -1;
	for (let i = 0; i < rootNode._components.length; i++) {
		const ref = rootNode._components[i];
		const index = ref && typeof ref.__id__ === 'number' ? ref.__id__ : -1;
		const component = prefabData[index];
		if (component && isTimelineComponentType(component.__type__, typeIds)) {
			componentIndex = index;
			break;
		}
	}

	let created = false;
	if (componentIndex === -1) {
		componentIndex = prefabData.length;
		prefabData.push(createTimelineComponentObject(
			rootNodeIndex,
			options.componentTypeId,
			options.timelineAssetUuid,
			options.timelineData
		));
		rootNode._components.push({ __id__: componentIndex });
		created = true;
	} else {
		const component = prefabData[componentIndex];
		component.__type__ = options.componentTypeId;
		component.node = { __id__: rootNodeIndex };
		if (component._enabled === undefined) component._enabled = true;
		const assetRefKey = getComponentAssetRefKey(component);
		component[assetRefKey] = { __uuid__: options.timelineAssetUuid };
		component.autoPlay = !!(options.timelineData && options.timelineData.autoPlay);
		component.loopMode = loopModeToRuntimeEnum(options.timelineData && options.timelineData.loopMode);
		if (component.speed === undefined) component.speed = 1;
		if (component._id === undefined) component._id = '';
	}

	return {
		created,
		componentIndex,
		rootNodeIndex,
		rootName: rootNode._name || '',
	};
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
	if (isTimelineComponentType(type)) {
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
		editorState = createDefaultEditorState();

		this.updatePixelsPerSecond();
	},

	close() {
		this.stopPrefabContextWatcher();
		this.stopPlayback();
		this.stopScenePreview();
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
		this.$el('#btnInstallRuntime').addEventListener('click', () => this.onInstallRuntime());
		this.$el('#btnBindRuntime').addEventListener('click', () => this.onBindRuntime());

		// 快速创建按钮
		this.$el('#btnQuickCreate').addEventListener('click', () => this.onQuickCreateTimeline());

		// 撤销/重做按钮
		this.$el('#btnUndo').addEventListener('click', () => this.undo());
		this.$el('#btnRedo').addEventListener('click', () => this.redo());

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
		[
			'#timelineName',
			'#timelineDuration',
			'#timelineFrameRate',
			'#timelineLoopMode',
			'#timelineAutoPlay',
		].forEach((selector) => {
			const input = this.$el(selector);
			input.addEventListener('focus', () => this.captureEditHistoryOnce(input));
			input.addEventListener('blur', () => this.releaseEditHistory(input));
		});

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
		ruler.addEventListener('mousedown', (e) => this.onRulerMouseDown(e));

		// 时间轴容器滚轮事件
		const tracksContainer = this.$el('#tracksContainer');
		if (tracksContainer) {
			tracksContainer.addEventListener('wheel', (e) => this.onTimelineWheel(e), { passive: false });
		}

		// 时间轴双击适配内容
		if (ruler) {
			ruler.addEventListener('dblclick', () => this.frameAll());
		}

		// 键盘快捷键
		document.addEventListener('keydown', (e) => this.onKeyDown(e));
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
		this.stopScenePreview();
		editorState.currentFile = null;
		editorState.selectedTrack = null;
		editorState.selectedClip = null;
		editorState.selectedClips = [];
		editorState.currentTime = 0;
		editorState.playbackDirection = 1;
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
		this.stopScenePreview();
		editorState.selectedTrack = null;
		editorState.selectedClip = null;
		editorState.selectedClips = [];
		editorState.isPlaying = false;
		editorState.currentTime = 0;
		editorState.playbackDirection = 1;
		this.setPlayButtonIcon(false);

		editorState.timelineData = createDefaultTimeline('new_timeline');

		// 清空历史记录
		this.clearHistory();

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
		const quickCreateBtn = this.$el('#btnQuickCreate');

		if (root) {
			root.classList.toggle('locked', !enabled);
		}

		if (overlay) {
			overlay.classList.toggle('hidden', !!enabled);
			const titleEl = this.$el('#contextTitle');
			const messageEl = this.$el('#contextMessage');
			if (titleEl && title) titleEl.textContent = title;
			if (messageEl && detail !== undefined) messageEl.textContent = detail || '';

			// 显示快速创建按钮：当有 prefab 但没有 timeline 时
			const context = editorState.prefabContext;
			const shouldShowQuickCreate = !enabled &&
				context &&
				context.inPrefab &&
				context.prefabUrl &&
				context.timeline &&
				context.timeline.missing;

			if (quickCreateBtn) {
				quickCreateBtn.style.display = shouldShowQuickCreate ? 'inline-block' : 'none';
			}
		}

		this.$$el('input, select, textarea').forEach((el) => {
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
			'#btnBindRuntime',
			'#btnUndo',
			'#btnRedo',
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
		this.updateUndoRedoButtons();
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

		const duration = clampNumber(editorState.timelineData.duration, 0.01, null, 5.0);
		const pps = editorState.pixelsPerSecond;
		const totalWidth = duration * pps;

		ruler.style.width = totalWidth + 'px';

		// 计算刻度间隔
		let interval = 1.0; // 默认 1 秒
		if (editorState.zoom >= 400) {
			interval = 0.1;
		} else if (editorState.zoom > 200) {
			interval = 0.5;
		} else if (editorState.zoom < 50) {
			interval = 5.0;
		} else if (editorState.zoom < 100) {
			interval = 2.0;
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
		if (track.locked) {
			trackEl.classList.add('locked');
		}
		if (track.muted) {
			trackEl.classList.add('muted');
		}
		if (track.enabled === false) {
			trackEl.classList.add('disabled');
		}

		// 轨道头部
		const header = document.createElement('div');
		header.className = 'track-header';
		header.innerHTML = `
			<div class="track-info">
				<div class="track-name">${escapeHtml(track.name || 'Track ' + (index + 1))}</div>
				<div class="track-type">默认 ${escapeHtml(track.type)}</div>
				<div class="track-target">${escapeHtml(track.targetPath || '.')}</div>
			</div>
			<div class="track-controls">
				<button class="track-control-btn ${track.locked ? 'active' : ''}" data-action="lock" title="${track.locked ? '解锁' : '锁定'}">
					🔒
				</button>
				<button class="track-control-btn ${track.muted ? 'active' : ''}" data-action="mute" title="${track.muted ? '取消静音' : '静音'}">
					🔇
				</button>
			</div>
		`;

		// 点击轨道信息区域选中轨道
		header.querySelector('.track-info').addEventListener('click', () => this.onSelectTrack(index));

		// 锁定/静音按钮
		header.querySelectorAll('.track-control-btn').forEach(btn => {
			btn.addEventListener('click', (e) => {
				e.stopPropagation();
				const action = btn.getAttribute('data-action');
				if (action === 'lock') {
					this.toggleTrackLock(index);
				} else if (action === 'mute') {
					this.toggleTrackMute(index);
				}
			});
		});

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
		const track = editorState.timelineData.tracks[trackIndex];
		clipEl.dataset.type = getClipType(track, clip);

		const pps = editorState.pixelsPerSecond;
		const left = clip.start * pps;
		const width = (clip.duration || 0.5) * pps;

		clipEl.style.left = left + 'px';
		clipEl.style.width = width + 'px';

		// 检查是否在多选列表中
		const isInMultiSelect = (editorState.selectedClips || []).some(
			s => s.trackIndex === trackIndex && s.clipIndex === clipIndex
		);

		if (isInMultiSelect) {
			clipEl.classList.add('selected');
		}

		clipEl.innerHTML = `
			<div class="clip-name">${escapeHtml(clip.name || 'Clip ' + (clipIndex + 1))}</div>
			<div class="clip-time">${formatTime(clip.start)}s - ${formatTime(clip.start + (clip.duration || 0))}s</div>
			<div class="clip-handle left"></div>
			<div class="clip-handle right"></div>
		`;

		// 点击选中
		clipEl.addEventListener('click', (e) => {
			e.stopPropagation();
			this.onSelectClip(trackIndex, clipIndex, e.ctrlKey || e.metaKey);
		});

		// 拖拽移动
		this.makeClipDraggable(clipEl, trackIndex, clipIndex);
		this.makeClipResizable(clipEl, trackIndex, clipIndex);

		return clipEl;
	},

	// 使片段可拖拽
	makeClipDraggable(clipEl, trackIndex, clipIndex) {
		let isDragging = false;
		let hasMoved = false;
		let startX = 0;
		let startLeft = 0;

		const onMouseDown = (e) => {
			if (e.target.classList.contains('clip-handle')) return;

			// 检查轨道是否锁定
			const track = editorState.timelineData.tracks[trackIndex];
			if (track && track.locked) {
				this.setStatus('轨道已锁定，无法编辑', 'error', 1500);
				return;
			}

			isDragging = true;
			hasMoved = false;
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
			if (Math.abs(deltaX) < 2 && !hasMoved) return;
			hasMoved = true;
			const track = editorState.timelineData.tracks[trackIndex];
			const clip = track && track.clips ? track.clips[clipIndex] : null;
			const clipWidth = ((clip && clip.duration) || 0.5) * editorState.pixelsPerSecond;
			const timelineWidth = clampNumber(editorState.timelineData.duration, 0.01, null, 5.0) * editorState.pixelsPerSecond;
			const maxLeft = Math.max(0, timelineWidth - clipWidth);
			let newLeft = Math.max(0, Math.min(maxLeft, startLeft + deltaX));

			// 吸附功能
			if (editorState.snapEnabled) {
				const snappedLeft = this.calculateSnap(newLeft, trackIndex, clipIndex);
				newLeft = Math.max(0, Math.min(maxLeft, snappedLeft));
			}

			clipEl.style.left = newLeft + 'px';
		};

		const onMouseUp = (e) => {
			if (!isDragging) return;

			isDragging = false;
			clipEl.classList.remove('dragging');

			// 清除吸附辅助线
			this.clearSnapGuides();

			if (!this.ensureTimelineEditable()) {
				document.removeEventListener('mousemove', onMouseMove);
				document.removeEventListener('mouseup', onMouseUp);
				return;
			}

			if (!hasMoved) {
				this.setClipSelection(trackIndex, clipIndex, e.ctrlKey || e.metaKey);
				this.renderTimeline();
				this.updateClipProperties();
				document.removeEventListener('mousemove', onMouseMove);
				document.removeEventListener('mouseup', onMouseUp);
				return;
			}

			// 保存历史记录
			this.pushHistory();

			// 更新数据
			const newStart = parseFloat(clipEl.style.left) / editorState.pixelsPerSecond;
			const clip = editorState.timelineData.tracks[trackIndex].clips[clipIndex];
			clip.start = Math.max(0, newStart);
			if (!(editorState.selectedClips || []).some((selection) => selection.trackIndex === trackIndex && selection.clipIndex === clipIndex)) {
				this.setClipSelection(trackIndex, clipIndex, false);
			}

			this.markDirty();
			this.renderTimeline();
			this.updateClipProperties();

			document.removeEventListener('mousemove', onMouseMove);
			document.removeEventListener('mouseup', onMouseUp);
		};

		clipEl.addEventListener('mousedown', onMouseDown);
	},

	// 使片段可调整时长
	makeClipResizable(clipEl, trackIndex, clipIndex) {
		const handles = clipEl.querySelectorAll('.clip-handle');
		handles.forEach((handle) => {
			let isResizing = false;
			let startX = 0;
			let startLeft = 0;
			let startWidth = 0;
			let side = 'right';

			const onMouseDown = (e) => {
				const track = editorState.timelineData.tracks[trackIndex];
				if (track && track.locked) {
					this.setStatus('轨道已锁定，无法编辑', 'error', 1500);
					return;
				}

				isResizing = true;
				side = handle.classList.contains('left') ? 'left' : 'right';
				startX = e.clientX;
				startLeft = parseFloat(clipEl.style.left) || 0;
				startWidth = parseFloat(clipEl.style.width) || 0;
				clipEl.classList.add('resizing');

				document.addEventListener('mousemove', onMouseMove);
				document.addEventListener('mouseup', onMouseUp);

				e.preventDefault();
				e.stopPropagation();
			};

			const onMouseMove = (e) => {
				if (!isResizing) return;

				const deltaX = e.clientX - startX;
				const pps = editorState.pixelsPerSecond;
				const minWidth = Math.max(1, 0.01 * pps);
				const timelineWidth = clampNumber(editorState.timelineData.duration, 0.01, null, 5.0) * pps;

				if (side === 'left') {
					let newLeft = Math.max(0, Math.min(startLeft + deltaX, startLeft + startWidth - minWidth));
					if (editorState.snapEnabled) {
						newLeft = Math.max(0, Math.min(this.calculateEdgeSnap(newLeft, trackIndex, clipIndex), startLeft + startWidth - minWidth));
					}
					clipEl.style.left = newLeft + 'px';
					clipEl.style.width = (startLeft + startWidth - newLeft) + 'px';
				} else {
					let newRight = Math.max(startLeft + minWidth, Math.min(startLeft + startWidth + deltaX, timelineWidth));
					if (editorState.snapEnabled) {
						newRight = Math.max(startLeft + minWidth, Math.min(this.calculateEdgeSnap(newRight, trackIndex, clipIndex), timelineWidth));
					}
					clipEl.style.width = (newRight - startLeft) + 'px';
				}
			};

			const onMouseUp = () => {
				if (!isResizing) return;

				isResizing = false;
				clipEl.classList.remove('resizing');
				this.clearSnapGuides();

				if (!this.ensureTimelineEditable()) {
					document.removeEventListener('mousemove', onMouseMove);
					document.removeEventListener('mouseup', onMouseUp);
					return;
				}

				this.pushHistory();

				const clip = editorState.timelineData.tracks[trackIndex].clips[clipIndex];
				const newStart = (parseFloat(clipEl.style.left) || 0) / editorState.pixelsPerSecond;
				const newDuration = (parseFloat(clipEl.style.width) || 1) / editorState.pixelsPerSecond;

				clip.start = clampNumber(newStart, 0, null, 0);
				clip.duration = clampNumber(newDuration, 0.01, null, 0.01);

				this.markDirty();
				this.renderTimeline();
				this.updateClipProperties();

				document.removeEventListener('mousemove', onMouseMove);
				document.removeEventListener('mouseup', onMouseUp);
			};

			handle.addEventListener('mousedown', onMouseDown);
		});
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
				<div class="track-list-item-content">
					<div class="track-list-item-name">${escapeHtml(track.name || 'Track ' + (index + 1))}</div>
					<div class="track-list-item-info">默认 ${escapeHtml(track.type)} · ${escapeHtml(track.targetPath || '.')}</div>
				</div>
				<div class="track-list-actions">
					<button class="track-move-btn" data-action="up" title="上移" ${index === 0 ? 'disabled' : ''}>↑</button>
					<button class="track-move-btn" data-action="down" title="下移" ${index === tracks.length - 1 ? 'disabled' : ''}>↓</button>
					<button class="track-delete-btn" title="删除轨道">×</button>
				</div>
			`;

			item.querySelector('.track-list-item-content').addEventListener('click', () => this.onSelectTrack(index));
			item.querySelectorAll('.track-move-btn').forEach((btn) => {
				btn.addEventListener('click', (e) => {
					e.stopPropagation();
					const action = btn.getAttribute('data-action');
					this.moveTrack(index, action === 'up' ? -1 : 1);
				});
			});
			item.querySelector('.track-delete-btn').addEventListener('click', (e) => {
				e.stopPropagation();
				this.onDeleteTrack(index);
			});

			list.appendChild(item);
		});
	},

	// 更新播放头位置
	updatePlayhead(options = {}) {
		const playhead = this.$el('#playhead');
		const pps = editorState.pixelsPerSecond;
		const left = TRACK_HEADER_WIDTH + (editorState.currentTime * pps);
		playhead.style.left = left + 'px';

		this.$el('#currentTime').textContent = editorState.currentTime.toFixed(2);

		if (!options.skipPreview) {
			this.previewTimelineAtCurrentTime({ playing: editorState.isPlaying });
		}
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

	onInstallRuntime() {
		try {
			ensureDirectory(Path.join(TIMELINE_RUNTIME_FS, 'placeholder'));

			const installed = [];
			const skipped = [];
			for (const item of RUNTIME_TEMPLATES) {
				const content = readPackageTemplate(item.templateUrl);
				if (Fs.existsSync(item.targetPath)) {
					const existing = Fs.readFileSync(item.targetPath, 'utf8');
					if (existing.indexOf(TIMELINE_RUNTIME_MARKER) === -1) {
						const shouldOverwrite = confirm(
							`${item.name} 已存在且不像 UI Timeline 生成文件，是否覆盖？`
						);
						if (!shouldOverwrite) {
							skipped.push(item.name);
							continue;
						}
					}
				}

				ensureDirectory(item.targetPath);
				Fs.writeFileSync(item.targetPath, content, 'utf8');
				installed.push(item.name);
			}

			refreshAssetUrl(TIMELINE_RUNTIME_URL);
			RUNTIME_TEMPLATES.forEach((item) => refreshAsset(item.targetPath));

			let message = installed.length > 0
				? '运行时已安装/更新: ' + installed.join(', ')
				: '运行时未改动';
			if (skipped.length > 0) {
				message += '；已跳过: ' + skipped.join(', ');
			}
			this.setStatus(message, installed.length > 0 ? 'success' : 'info', 5000);
		} catch (err) {
			this.setStatus('安装运行时失败: ' + (err && err.message ? err.message : err), 'error', 5000);
		}
	},

	onBindRuntime() {
		if (!this.ensureTimelineEditable()) return;

		const context = editorState.prefabContext;
		const prefabUrl = context && context.prefabUrl;
		const prefabPath = urlToFspath(prefabUrl);
		if (!prefabUrl || !prefabPath || !Fs.existsSync(prefabPath)) {
			this.setStatus('无法绑定：当前 Prefab 文件不存在', 'error', 5000);
			return;
		}

		if (!editorState.currentFile || !Fs.existsSync(editorState.currentFile)) {
			this.setStatus('无法绑定：请先保存当前 Timeline', 'error', 5000);
			return;
		}

		const componentInfo = getTimelineComponentScriptInfo();
		if (!componentInfo) {
			this.setStatus('无法绑定：请先安装运行时并等待 TimelineComponent.ts 编译生成 meta', 'error', 7000);
			return;
		}

		const timelineAssetUuid = readMetaUuid(editorState.currentFile);
		if (!timelineAssetUuid) {
			this.setStatus('无法绑定：Timeline JSON meta 尚未生成，请保存后等待资源刷新', 'error', 7000);
			refreshAsset(editorState.currentFile);
			return;
		}

		if (!confirm('将当前 TimelineComponent 绑定到 Prefab 根节点并保存 Prefab，是否继续？')) {
			return;
		}

		try {
			const prefabData = JSON.parse(Fs.readFileSync(prefabPath, 'utf8'));
			const result = bindTimelineComponentToPrefabData(prefabData, {
				componentTypeId: componentInfo.typeId,
				typeIds: getTimelineComponentTypeIds(),
				timelineAssetUuid,
				timelineData: editorState.timelineData,
			});

			Fs.writeFileSync(prefabPath, JSON.stringify(prefabData, null, 2), 'utf8');
			refreshAsset(prefabPath);

			const verb = result.created ? '已挂载并绑定' : '已更新绑定';
			this.setStatus(`${verb}: ${result.rootName || Path.basename(prefabUrl, '.prefab')}`, 'success', 5000);
			this.checkPrefabContext(true);
		} catch (err) {
			this.setStatus('绑定失败: ' + (err && err.message ? err.message : err), 'error', 7000);
		}
	},

	onQuickCreateTimeline() {
		const context = editorState.prefabContext;
		if (!context || !context.inPrefab || !context.prefabUrl || !context.timeline || !context.timeline.missing) {
			this.setStatus('无法快速创建：未找到 Prefab 或 Timeline 信息', 'error');
			return;
		}

		const prefabName = Path.basename(context.prefabUrl, '.prefab');
		const timelinePath = context.timeline.filePath;

		if (!timelinePath) {
			this.setStatus('无法确定 Timeline 保存路径', 'error');
			return;
		}

		// 创建空 Timeline 数据
		const newTimeline = normalizeTimelineData(createDefaultTimeline(prefabName), prefabName);

		try {
			// 保存文件
			const content = JSON.stringify(newTimeline, null, 2);
			ensureDirectory(timelinePath);
			Fs.writeFileSync(timelinePath, content, 'utf8');
			refreshAsset(timelinePath);

			// 设置当前数据
			editorState.timelineData = newTimeline;
			editorState.currentFile = timelinePath;
			editorState.isDirty = false;

			// 初始化历史记录
			this.clearHistory();
			this.pushHistory();

			// 更新上下文状态
			const updatedTimeline = {
				url: context.timeline.url,
				filePath: timelinePath,
				source: 'quick-create',
				missing: false,
			};
			editorState.prefabContext = Object.assign({}, context, { timeline: updatedTimeline });
			const timelineState = 'ready';
			editorState.contextKey = context.prefabUrl + '|' + timelineState + '|' + updatedTimeline.source + '|' + timelinePath;

			// 切换到可编辑状态
			this.setTimelineEditable(true, '正在编辑当前 Prefab 的 Timeline', context.prefabUrl);
			this.updateUI();
			this.setStatus('已创建并绑定: ' + prefabName + '.json', 'success');
		} catch (err) {
			this.setStatus('创建失败: ' + err.message, 'error');
		}
	},

	onPlayPause() {
		if (!this.ensureTimelineEditable()) return;

		editorState.isPlaying = !editorState.isPlaying;

		this.setPlayButtonIcon(editorState.isPlaying);

		if (editorState.isPlaying) {
			const duration = clampNumber(editorState.timelineData.duration, 0.01, null, 5.0);
			if (editorState.currentTime >= duration && editorState.playbackDirection >= 0) {
				editorState.currentTime = 0;
				editorState.playbackDirection = 1;
				this.updatePlayhead();
			}
			this.startPlayback();
		} else {
			this.stopPlayback();
		}
	},

	onStop() {
		if (!this.ensureTimelineEditable()) return;

		editorState.isPlaying = false;
		editorState.currentTime = 0;
		editorState.playbackDirection = 1;

		this.setPlayButtonIcon(false);

		this.stopPlayback();
		this.stopScenePreview();
		this.updatePlayhead({ skipPreview: true });
	},

	onSeekToStart() {
		if (!this.ensureTimelineEditable()) return;

		editorState.currentTime = 0;
		editorState.playbackDirection = 1;
		this.updatePlayhead();
	},

	onSeekToEnd() {
		if (!this.ensureTimelineEditable()) return;

		editorState.currentTime = editorState.timelineData.duration || 5.0;
		editorState.playbackDirection = 1;
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

		// 保存历史记录
		this.pushHistory();

		const track = {
			id: 'track_' + Date.now(),
			name: name,
			type: type,
			targetPath: targetPath,
			enabled: true,
			locked: false,
			muted: false,
			clips: [],
		};

		editorState.timelineData.tracks.push(track);
		editorState.selectedTrack = editorState.timelineData.tracks.length - 1;
		editorState.selectedClip = null;
		editorState.selectedClips = [];
		this.markDirty();
		this.renderTimeline();
		this.updateClipProperties();
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
		if (!track) {
			this.setStatus('选中的轨道无效', 'error');
			return;
		}

		// 检查轨道是否锁定
		if (track && track.locked) {
			this.setStatus('轨道已锁定，无法添加片段', 'error');
			return;
		}

		// 保存历史记录
		this.pushHistory();

		const clip = createDefaultClip(type, editorState.currentTime);

		track.clips.push(clip);
		const clipIndex = track.clips.length - 1;
		editorState.selectedClip = clipIndex;
		editorState.selectedClips = [{ trackIndex: editorState.selectedTrack, clipIndex }];
		editorState.timelineData.duration = Math.max(
			editorState.timelineData.duration,
			Math.ceil((clip.start + clip.duration) * 100) / 100
		);
		this.markDirty();
		this.renderTimeline();
		this.updateClipProperties();
		this.setStatus('已添加片段', 'success');
	},

	onSelectTrack(index) {
		if (!this.ensureTimelineEditable()) return;
		if (!editorState.timelineData.tracks[index]) {
			this.setStatus('选中的轨道无效', 'error');
			return;
		}

		editorState.selectedTrack = index;
		editorState.selectedClip = null;
		editorState.selectedClips = [];
		this.renderTimeline();
		this.updateClipProperties();
	},

	setClipSelection(trackIndex, clipIndex, multiSelect = false) {
		editorState.selectedClips = editorState.selectedClips || [];

		if (multiSelect) {
			// 多选模式
			const index = editorState.selectedClips.findIndex(
				s => s.trackIndex === trackIndex && s.clipIndex === clipIndex
			);

			if (index >= 0) {
				// 已选中，取消选中
				editorState.selectedClips.splice(index, 1);
			} else {
				// 未选中，添加到选中列表
				editorState.selectedClips.push({ trackIndex, clipIndex });
			}

			// 如果多选列表为空，清除选中
			if (editorState.selectedClips.length === 0) {
				editorState.selectedTrack = null;
				editorState.selectedClip = null;
			} else {
				// 主选中项设为最后一个
				const last = editorState.selectedClips[editorState.selectedClips.length - 1];
				editorState.selectedTrack = last.trackIndex;
				editorState.selectedClip = last.clipIndex;
			}
		} else {
			// 单选模式，清空多选
			editorState.selectedClips = [{ trackIndex, clipIndex }];
			editorState.selectedTrack = trackIndex;
			editorState.selectedClip = clipIndex;
		}
	},

	onSelectClip(trackIndex, clipIndex, multiSelect = false) {
		if (!this.ensureTimelineEditable()) return;

		this.setClipSelection(trackIndex, clipIndex, multiSelect);

		this.renderTimeline();
		this.updateClipProperties();
	},

	onRulerClick(e) {
		if (!this.ensureTimelineEditable()) return;

		this.seekFromRulerEvent(e.currentTarget, e);
	},

	onRulerMouseDown(e) {
		if (!this.ensureTimelineEditable()) return;

		const ruler = e.currentTarget;
		this.seekFromRulerEvent(ruler, e);

		const onMouseMove = (moveEvent) => {
			this.seekFromRulerEvent(ruler, moveEvent);
		};

		const onMouseUp = () => {
			document.removeEventListener('mousemove', onMouseMove);
			document.removeEventListener('mouseup', onMouseUp);
		};

		document.addEventListener('mousemove', onMouseMove);
		document.addEventListener('mouseup', onMouseUp);
		e.preventDefault();
	},

	seekFromRulerEvent(ruler, e) {
		const rect = ruler.getBoundingClientRect();
		const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
		const time = x / editorState.pixelsPerSecond;
		editorState.currentTime = Math.max(0, Math.min(time, editorState.timelineData.duration));
		this.updatePlayhead();
	},

	onTimelinePropertyChange(key, value) {
		if (!this.ensureTimelineEditable()) return;

		if (key === 'duration') {
			value = clampNumber(value, 0.01, null, editorState.timelineData.duration || 5.0);
		} else if (key === 'frameRate') {
			value = Math.max(1, parseInt(value, 10) || editorState.timelineData.frameRate || 60);
		}

		editorState.timelineData[key] = value;
		this.markDirty();

		if (key === 'duration') {
			editorState.currentTime = Math.min(editorState.currentTime, value);
			this.renderTimeline();
			this.updatePlayhead();
		} else if (key === 'frameRate') {
			if (editorState.isPlaying) {
				this.stopPlayback();
				this.startPlayback();
			}
		}
	},

	onConfirmNew() {
		this.closeDialog('dialogNew');
		this.setStatus('Timeline 由当前 Prefab 自动绑定，不能手动新建', 'error');
	},

	onDeleteTrack(trackIndex) {
		if (!this.ensureTimelineEditable()) return;

		const track = editorState.timelineData.tracks[trackIndex];
		if (!track) return;

		const trackName = track.name || 'Track ' + (trackIndex + 1);
		if (!confirm(`确定要删除轨道 "${trackName}" 吗？`)) {
			return;
		}

		// 保存历史记录
		this.pushHistory();

		editorState.timelineData.tracks.splice(trackIndex, 1);

		// 清除选中状态
		if (editorState.selectedTrack === trackIndex) {
			editorState.selectedTrack = null;
			editorState.selectedClip = null;
			editorState.selectedClips = [];
		} else if (editorState.selectedTrack > trackIndex) {
			editorState.selectedTrack--;
		}

		editorState.selectedClips = (editorState.selectedClips || [])
			.filter((selection) => selection.trackIndex !== trackIndex)
			.map((selection) => {
				if (selection.trackIndex > trackIndex) {
					return {
						trackIndex: selection.trackIndex - 1,
						clipIndex: selection.clipIndex,
					};
				}
				return selection;
			});

		this.markDirty();
		this.renderTimeline();
		this.updateClipProperties();
		this.setStatus('已删除轨道: ' + trackName, 'success');
	},

	moveTrack(trackIndex, delta) {
		if (!this.ensureTimelineEditable()) return;

		const tracks = editorState.timelineData.tracks || [];
		const targetIndex = trackIndex + delta;
		if (trackIndex < 0 || trackIndex >= tracks.length || targetIndex < 0 || targetIndex >= tracks.length) {
			return;
		}

		this.pushHistory();

		const [track] = tracks.splice(trackIndex, 1);
		tracks.splice(targetIndex, 0, track);

		const remapTrackIndex = (index) => {
			if (index === trackIndex) return targetIndex;
			if (index === targetIndex) return trackIndex;
			return index;
		};

		if (editorState.selectedTrack !== null) {
			editorState.selectedTrack = remapTrackIndex(editorState.selectedTrack);
		}
		editorState.selectedClips = (editorState.selectedClips || []).map((selection) => ({
			trackIndex: remapTrackIndex(selection.trackIndex),
			clipIndex: selection.clipIndex,
		}));

		this.markDirty();
		this.renderTimeline();
		this.updateClipProperties();
		this.setStatus('已调整轨道顺序', 'success', 1000);
	},

	onDeleteClip(trackIndex, clipIndex) {
		if (!this.ensureTimelineEditable()) return;

		const track = editorState.timelineData.tracks[trackIndex];
		if (!track || !track.clips || !track.clips[clipIndex]) return;

		// 检查轨道是否锁定
		if (track.locked) {
			this.setStatus('轨道已锁定，无法删除片段', 'error');
			return;
		}

		const clip = track.clips[clipIndex];
		const clipName = clip.name || 'Clip ' + (clipIndex + 1);

		if (!confirm(`确定要删除片段 "${clipName}" 吗？`)) {
			return;
		}

		// 保存历史记录
		this.pushHistory();

		track.clips.splice(clipIndex, 1);

		// 清除选中状态
		editorState.selectedClip = null;
		editorState.selectedClips = (editorState.selectedClips || [])
			.filter((selection) => !(selection.trackIndex === trackIndex && selection.clipIndex === clipIndex))
			.map((selection) => {
				if (selection.trackIndex === trackIndex && selection.clipIndex > clipIndex) {
					return {
						trackIndex: selection.trackIndex,
						clipIndex: selection.clipIndex - 1,
					};
				}
				return selection;
			});

		this.markDirty();
		this.renderTimeline();
		this.updateClipProperties();
		this.setStatus('已删除片段: ' + clipName, 'success');
	},

	copyClip() {
		if (!this.ensureTimelineEditable()) return;
		editorState.selectedClips = editorState.selectedClips || [];

		// 检查是否有多选
		if (editorState.selectedClips.length === 0) {
			this.setStatus('请先选择要复制的片段', 'error');
			return;
		}

		// 批量复制
		const clipsToCopy = [];
		editorState.selectedClips.forEach(({ trackIndex, clipIndex }) => {
			const track = editorState.timelineData.tracks[trackIndex];
			if (track && track.clips && track.clips[clipIndex]) {
				const clipCopy = cloneData(track.clips[clipIndex]);
				clipCopy.type = getClipType(track, clipCopy);
				clipsToCopy.push({
					trackIndex,
					clip: clipCopy
				});
			}
		});

		if (clipsToCopy.length === 0) {
			this.setStatus('选中的片段无效', 'error');
			return;
		}

		// 深拷贝到剪贴板
		editorState.clipboard = clipsToCopy;

		const count = clipsToCopy.length;
		this.setStatus(`已复制 ${count} 个片段`, 'success', 1000);
	},

	pasteClip() {
		if (!this.ensureTimelineEditable()) return;

		// 检查剪贴板是否有内容
		if (!editorState.clipboard) {
			this.setStatus('剪贴板为空，请先复制片段', 'error');
			return;
		}

		// 必须选中轨道才能粘贴
		if (editorState.selectedTrack === null) {
			this.setStatus('请先选择要粘贴到的轨道', 'error');
			return;
		}

		const track = editorState.timelineData.tracks[editorState.selectedTrack];
		if (!track) {
			this.setStatus('选中的轨道无效', 'error');
			return;
		}
		if (track.locked) {
			this.setStatus('轨道已锁定，无法粘贴片段', 'error');
			return;
		}

		// 检查剪贴板是数组还是单个片段（兼容旧版）
		const clipsToPaste = Array.isArray(editorState.clipboard)
			? editorState.clipboard
			: [{ trackIndex: editorState.selectedTrack, clip: editorState.clipboard }];

		// 保存历史记录
		this.pushHistory();

		const newClips = [];
		clipsToPaste.forEach(({ clip }, index) => {
			// 深拷贝剪贴板内容
			const newClip = JSON.parse(JSON.stringify(clip));

			// 生成新的 ID
			newClip.id = 'clip_' + Date.now() + '_' + index;

			// 粘贴到当前播放头位置
			newClip.start = editorState.currentTime;
			newClip.type = getClipType(track, newClip);

			// 添加到轨道
			track.clips.push(newClip);
			newClips.push({ trackIndex: editorState.selectedTrack, clipIndex: track.clips.length - 1 });
			editorState.timelineData.duration = Math.max(
				editorState.timelineData.duration,
				Math.ceil((newClip.start + (newClip.duration || 0)) * 100) / 100
			);
		});

		// 选中新粘贴的片段
		editorState.selectedClips = newClips;
		if (newClips.length > 0) {
			const last = newClips[newClips.length - 1];
			editorState.selectedClip = last.clipIndex;
		}

		this.markDirty();
		this.renderTimeline();
		this.updateClipProperties();
		this.setStatus(`已粘贴 ${newClips.length} 个片段`, 'success', 1000);
	},

	onTimelineWheel(e) {
		if (!editorState.timelineData) return;

		// Shift 或 Alt 键 + 滚轮 = 水平滚动
		if (e.shiftKey || e.altKey) {
			// 让浏览器处理水平滚动
			return;
		}

		// 普通滚轮 = 缩放
		e.preventDefault();

		const delta = e.deltaY;
		const zoomSpeed = 5; // 每次滚动的缩放量

		// 向上滚动 = 放大，向下滚动 = 缩小
		const oldZoom = editorState.zoom;
		if (delta < 0) {
			editorState.zoom = Math.min(400, editorState.zoom + zoomSpeed);
		} else {
			editorState.zoom = Math.max(25, editorState.zoom - zoomSpeed);
		}

		// 如果缩放级别改变了
		if (oldZoom !== editorState.zoom) {
			this.updatePixelsPerSecond();
			this.$el('#zoomLevel').textContent = editorState.zoom + '%';
			this.renderTimeline();
		}
	},

	frameAll() {
		if (!editorState.timelineData || !editorState.timelineData.tracks) return;

		const tracks = editorState.timelineData.tracks;
		if (tracks.length === 0) {
			// 没有轨道，重置为默认视图
			editorState.zoom = 100;
			this.updatePixelsPerSecond();
			this.$el('#zoomLevel').textContent = editorState.zoom + '%';
			this.renderTimeline();
			return;
		}

		// 找到所有片段的最大结束时间
		let maxEndTime = 0;
		tracks.forEach(track => {
			if (track.clips && track.clips.length > 0) {
				track.clips.forEach(clip => {
					const endTime = clip.start + (clip.duration || 0);
					if (endTime > maxEndTime) {
						maxEndTime = endTime;
					}
				});
			}
		});

		// 如果没有片段，使用 timeline 的 duration
		if (maxEndTime === 0) {
			maxEndTime = editorState.timelineData.duration || 5.0;
		}

		// 计算合适的缩放级别
		// 假设容器宽度约为 800px（可以动态获取）
		const tracksContainer = this.$el('#tracksContainer');
		const containerWidth = tracksContainer ? tracksContainer.clientWidth - TRACK_HEADER_WIDTH : 680; // 减去左侧轨道头部的宽度

		// 计算需要的 pixelsPerSecond
		const targetPPS = containerWidth / maxEndTime * 0.9; // 0.9 留一点边距

		// 根据 pixelsPerSecond 计算 zoom
		// pixelsPerSecond = 100 * (zoom / 100)
		const targetZoom = (targetPPS / 100) * 100;

		// 限制缩放范围
		editorState.zoom = Math.max(25, Math.min(400, targetZoom));

		this.updatePixelsPerSecond();
		this.$el('#zoomLevel').textContent = editorState.zoom + '%';
		this.renderTimeline();

		this.setStatus('已适配所有内容', 'success', 1000);
	},

	// 计算吸附位置
	calculateSnap(position, trackIndex, clipIndex) {
		if (!editorState.snapEnabled) return position;

		const threshold = editorState.snapThreshold;
		const pps = editorState.pixelsPerSecond;
		const tracks = editorState.timelineData.tracks;
		const currentClip = tracks[trackIndex].clips[clipIndex];
		const clipWidth = (currentClip.duration || 0) * pps;

		let snapTargets = [];

		// 1. 吸附到网格（整秒）
		if (editorState.snapToGrid) {
			const timeInSeconds = position / pps;
			const nearestSecond = Math.round(timeInSeconds);
			const gridPosition = nearestSecond * pps;
			snapTargets.push({ position: gridPosition, guidePosition: gridPosition, type: 'grid' });
		}

		// 2. 吸附到其他片段
		if (editorState.snapToClips) {
			tracks.forEach((track, tIndex) => {
				if (!track.clips) return;
				track.clips.forEach((clip, cIndex) => {
					// 跳过自己
					if (tIndex === trackIndex && cIndex === clipIndex) return;

					const clipLeft = clip.start * pps;
					const clipRight = (clip.start + (clip.duration || 0)) * pps;

					// 吸附到片段的左边缘（当前片段的左边缘）
					snapTargets.push({ position: clipLeft, guidePosition: clipLeft, type: 'clip-start' });
					// 吸附到片段的右边缘（当前片段的左边缘）
					snapTargets.push({ position: clipRight, guidePosition: clipRight, type: 'clip-end' });
					// 吸附到片段的左边缘（当前片段的右边缘）
					snapTargets.push({ position: clipLeft - clipWidth, guidePosition: clipLeft, type: 'clip-start-right' });
					// 吸附到片段的右边缘（当前片段的右边缘）
					snapTargets.push({ position: clipRight - clipWidth, guidePosition: clipRight, type: 'clip-end-right' });
				});
			});
		}

		// 3. 找到最近的吸附目标
		let bestSnap = null;
		let bestDistance = threshold;

		snapTargets.forEach(target => {
			const distance = Math.abs(position - target.position);
			if (distance < bestDistance) {
				bestDistance = distance;
				bestSnap = target;
			}
		});

		// 如果找到吸附目标
		if (bestSnap) {
			this.showSnapGuide(bestSnap.guidePosition);
			return bestSnap.position;
		}

		this.clearSnapGuides();
		return position;
	},

	// 计算单个边缘的吸附位置
	calculateEdgeSnap(position, trackIndex, clipIndex) {
		if (!editorState.snapEnabled) return position;

		const threshold = editorState.snapThreshold;
		const pps = editorState.pixelsPerSecond;
		const tracks = editorState.timelineData.tracks;
		const snapTargets = [];

		if (editorState.snapToGrid) {
			const timeInSeconds = position / pps;
			const nearestSecond = Math.round(timeInSeconds);
			const gridPosition = nearestSecond * pps;
			snapTargets.push({ position: gridPosition, type: 'grid' });
		}

		if (editorState.snapToClips) {
			tracks.forEach((track, tIndex) => {
				if (!track.clips) return;
				track.clips.forEach((clip, cIndex) => {
					if (tIndex === trackIndex && cIndex === clipIndex) return;
					snapTargets.push({ position: clip.start * pps, type: 'clip-start' });
					snapTargets.push({ position: (clip.start + (clip.duration || 0)) * pps, type: 'clip-end' });
				});
			});
		}

		let bestSnap = null;
		let bestDistance = threshold;
		snapTargets.forEach((target) => {
			const distance = Math.abs(position - target.position);
			if (distance < bestDistance) {
				bestDistance = distance;
				bestSnap = target;
			}
		});

		if (bestSnap) {
			this.showSnapGuide(bestSnap.position);
			return bestSnap.position;
		}

		this.clearSnapGuides();
		return position;
	},

	// 显示吸附辅助线
	showSnapGuide(position) {
		this.clearSnapGuides();

		const tracksContainer = this.$el('#tracksContainer');
		if (!tracksContainer) return;

		const guide = document.createElement('div');
		guide.className = 'snap-guide';
		guide.style.left = (TRACK_HEADER_WIDTH + position) + 'px';
		tracksContainer.appendChild(guide);

		editorState.snapGuides.push(guide);
	},

	// 清除吸附辅助线
	clearSnapGuides() {
		editorState.snapGuides = editorState.snapGuides || [];
		editorState.snapGuides.forEach(guide => {
			if (guide.parentNode) {
				guide.parentNode.removeChild(guide);
			}
		});
		editorState.snapGuides = [];
	},

	// 切换轨道锁定状态
	toggleTrackLock(trackIndex) {
		if (!this.ensureTimelineEditable()) return;

		const track = editorState.timelineData.tracks[trackIndex];
		if (!track) return;

		// 保存历史记录
		this.pushHistory();

		track.locked = !track.locked;

		this.markDirty();
		this.renderTimeline();

		const status = track.locked ? '已锁定' : '已解锁';
		this.setStatus(`轨道 "${track.name || 'Track ' + (trackIndex + 1)}" ${status}`, 'success', 1000);
	},

	// 切换轨道静音状态
	toggleTrackMute(trackIndex) {
		if (!this.ensureTimelineEditable()) return;

		const track = editorState.timelineData.tracks[trackIndex];
		if (!track) return;

		// 保存历史记录
		this.pushHistory();

		track.muted = !track.muted;

		this.markDirty();
		this.renderTimeline();

		const status = track.muted ? '已静音' : '已取消静音';
		this.setStatus(`轨道 "${track.name || 'Track ' + (trackIndex + 1)}" ${status}`, 'success', 1000);
	},

	// 批量删除选中的片段
	deleteSelectedClips() {
		if (!this.ensureTimelineEditable()) return;
		editorState.selectedClips = editorState.selectedClips || [];

		if (editorState.selectedClips.length === 0) {
			this.setStatus('没有选中的片段', 'error');
			return;
		}

		// 检查是否有锁定的轨道
		const hasLockedTrack = editorState.selectedClips.some(({ trackIndex }) => {
			const track = editorState.timelineData.tracks[trackIndex];
			return track && track.locked;
		});

		if (hasLockedTrack) {
			this.setStatus('部分轨道已锁定，无法删除', 'error');
			return;
		}

		const count = editorState.selectedClips.length;
		if (!confirm(`确定要删除选中的 ${count} 个片段吗？`)) {
			return;
		}

		// 保存历史记录
		this.pushHistory();

		// 按轨道分组，从后向前删除（避免索引变化）
		const clipsByTrack = {};
		editorState.selectedClips.forEach(({ trackIndex, clipIndex }) => {
			if (!clipsByTrack[trackIndex]) {
				clipsByTrack[trackIndex] = [];
			}
			clipsByTrack[trackIndex].push(clipIndex);
		});

		// 对每个轨道的片段索引排序（降序）
		Object.keys(clipsByTrack).forEach(trackIndex => {
			clipsByTrack[trackIndex].sort((a, b) => b - a);
		});

		// 删除片段
		Object.keys(clipsByTrack).forEach(trackIndex => {
			const track = editorState.timelineData.tracks[trackIndex];
			if (!track || !track.clips) return;

			clipsByTrack[trackIndex].forEach(clipIndex => {
				track.clips.splice(clipIndex, 1);
			});
		});

		// 清除选中状态
		editorState.selectedClips = [];
		editorState.selectedTrack = null;
		editorState.selectedClip = null;

		this.markDirty();
		this.renderTimeline();
		this.updateClipProperties();
		this.setStatus(`已删除 ${count} 个片段`, 'success');
	},

	// 全选所有片段
	selectAllClips() {
		if (!editorState.timelineData || !editorState.timelineData.tracks) return;

		editorState.selectedClips = [];

		editorState.timelineData.tracks.forEach((track, trackIndex) => {
			if (track.clips && track.clips.length > 0) {
				track.clips.forEach((clip, clipIndex) => {
					editorState.selectedClips.push({ trackIndex, clipIndex });
				});
			}
		});

		if (editorState.selectedClips.length > 0) {
			const last = editorState.selectedClips[editorState.selectedClips.length - 1];
			editorState.selectedTrack = last.trackIndex;
			editorState.selectedClip = last.clipIndex;

			this.renderTimeline();
			this.updateClipProperties();
			this.setStatus(`已选中 ${editorState.selectedClips.length} 个片段`, 'success', 1000);
		} else {
			this.setStatus('没有可选中的片段', 'info', 1000);
		}
	},

	onKeyDown(e) {
		if (isEditableKeyboardEvent(e)) return;

		if (!editorState.isTimelineEditable) return;

		const key = String(e.key || '').toLowerCase();

		// Ctrl+C 复制
		if ((e.ctrlKey || e.metaKey) && key === 'c') {
			e.preventDefault();
			this.copyClip();
			return;
		}

		// Ctrl+V 粘贴
		if ((e.ctrlKey || e.metaKey) && key === 'v') {
			e.preventDefault();
			this.pasteClip();
			return;
		}

		// Ctrl+A 全选
		if ((e.ctrlKey || e.metaKey) && key === 'a') {
			e.preventDefault();
			this.selectAllClips();
			return;
		}

		// Ctrl+Z 撤销
		if ((e.ctrlKey || e.metaKey) && key === 'z' && !e.shiftKey) {
			e.preventDefault();
			this.undo();
			return;
		}

		// Ctrl+Y 或 Ctrl+Shift+Z 重做
		if ((e.ctrlKey || e.metaKey) && (key === 'y' || (key === 'z' && e.shiftKey))) {
			e.preventDefault();
			this.redo();
			return;
		}

		// F 键 - Frame All（适配所有内容）
		if (key === 'f') {
			e.preventDefault();
			this.frameAll();
			return;
		}

		// 左右方向键 - 逐帧移动播放头或选中片段
		if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			e.preventDefault();
			const direction = e.key === 'ArrowLeft' ? -1 : 1;
			const frameStep = 1 / Math.max(1, parseInt(editorState.timelineData.frameRate, 10) || 60);
			const step = frameStep * (e.shiftKey ? 10 : 1) * direction;
			if (editorState.selectedClips && editorState.selectedClips.length > 0) {
				this.nudgeSelectedClips(step);
			} else {
				this.seekBy(step);
			}
			return;
		}

		// Delete 或 Backspace 键删除
		if (e.key === 'Delete' || e.key === 'Backspace') {
			e.preventDefault();

			// 批量删除选中的片段
			if (editorState.selectedClips && editorState.selectedClips.length > 0) {
				this.deleteSelectedClips();
			}
			// 删除选中的轨道（如果没有选中片段）
			else if (editorState.selectedTrack !== null) {
				this.onDeleteTrack(editorState.selectedTrack);
			}
			else {
				this.setStatus('请先选中要删除的片段或轨道', 'error');
			}
		}
	},

	seekBy(deltaTime) {
		const duration = clampNumber(editorState.timelineData.duration, 0.01, null, 5.0);
		editorState.currentTime = Math.max(0, Math.min(duration, editorState.currentTime + deltaTime));
		this.updatePlayhead();
	},

	nudgeSelectedClips(deltaTime) {
		if (!this.ensureTimelineEditable()) return;

		const selections = editorState.selectedClips || [];
		if (selections.length === 0) return;

		const lockedSelection = selections.find(({ trackIndex }) => {
			const track = editorState.timelineData.tracks[trackIndex];
			return track && track.locked;
		});
		if (lockedSelection) {
			this.setStatus('轨道已锁定，无法移动片段', 'error', 1500);
			return;
		}

		let minStart = Infinity;
		let maxEnd = 0;
		selections.forEach(({ trackIndex, clipIndex }) => {
			const track = editorState.timelineData.tracks[trackIndex];
			const clip = track && track.clips ? track.clips[clipIndex] : null;
			if (!clip) return;
			minStart = Math.min(minStart, clip.start);
			maxEnd = Math.max(maxEnd, clip.start + (clip.duration || 0));
		});
		if (!Number.isFinite(minStart)) return;

		const duration = clampNumber(editorState.timelineData.duration, 0.01, null, 5.0);
		const clampedDelta = Math.max(-minStart, Math.min(deltaTime, duration - maxEnd));
		if (Math.abs(clampedDelta) < 0.000001) return;

		this.pushHistory();
		selections.forEach(({ trackIndex, clipIndex }) => {
			const clip = editorState.timelineData.tracks[trackIndex].clips[clipIndex];
			clip.start = Math.max(0, clip.start + clampedDelta);
		});
		this.markDirty();
		this.renderTimeline();
		this.updateClipProperties();
	},

	getClipSpecificFields(type, clip) {
		switch (type) {
			case 'animation':
				return [
					{ label: 'Animation 剪辑名', prop: 'clipName', type: 'text', value: clip.clipName || '' },
					{ label: '播放速度', prop: 'speed', type: 'number', step: '0.1', min: '0', value: clip.speed === undefined ? 1 : clip.speed },
					{ label: '循环', prop: 'loop', type: 'checkbox', value: !!clip.loop },
				];
			case 'spine':
				return [
					{ label: 'Spine 动画名', prop: 'animName', type: 'text', value: clip.animName || '' },
					{ label: 'Spine 轨道索引', prop: 'trackIndex', type: 'number', step: '1', min: '0', value: clip.trackIndex || 0 },
					{ label: '播放速度', prop: 'speed', type: 'number', step: '0.1', min: '0', value: clip.speed === undefined ? 1 : clip.speed },
					{ label: '循环', prop: 'loop', type: 'checkbox', value: !!clip.loop },
				];
			case 'tween':
				return [
					{ label: '目标属性 props (JSON)', prop: 'props', type: 'json', value: stringifyJsonValue(clip.props, {}) },
					{ label: '起始属性 from (JSON 或 null)', prop: 'from', type: 'json', value: stringifyJsonValue(clip.from, null) },
					{
						label: '缓动',
						prop: 'easing',
						type: 'select',
						value: clip.easing || 'linear',
						options: ['linear', 'sineIn', 'sineOut', 'sineInOut', 'quadIn', 'quadOut', 'quadInOut', 'cubicIn', 'cubicOut', 'cubicInOut', 'backOut', 'bounceOut'],
					},
				];
			case 'code':
				return [
					{ label: '回调名称', prop: 'callbackName', type: 'text', value: clip.callbackName || '' },
					{ label: '回调参数 params (JSON 数组)', prop: 'params', type: 'json', value: stringifyJsonValue(clip.params, []) },
				];
			case 'audio':
				return [
					{ label: '音频资源路径', prop: 'audioUrl', type: 'text', value: clip.audioUrl || '' },
					{ label: '音量', prop: 'volume', type: 'number', step: '0.01', min: '0', max: '1', value: clip.volume === undefined ? 1 : clip.volume },
					{ label: '循环', prop: 'loop', type: 'checkbox', value: !!clip.loop },
				];
			case 'active':
				return [
					{ label: '激活节点', prop: 'active', type: 'checkbox', value: clip.active !== false },
				];
			default:
				return [];
		}
	},

	renderClipPropertyField(field) {
		const label = escapeHtml(field.label);
		const prop = escapeHtml(field.prop);

		if (field.type === 'checkbox') {
			return `
				<div class="property-group">
					<label>
						<input type="checkbox" data-prop="${prop}" ${field.value ? 'checked' : ''}>
						${label}
					</label>
				</div>
			`;
		}

		if (field.type === 'json') {
			return `
				<div class="property-group">
					<label>${label}</label>
					<textarea data-prop="${prop}" data-json="true" spellcheck="false">${escapeHtml(field.value)}</textarea>
				</div>
			`;
		}

		if (field.type === 'select') {
			const options = (field.options || []).map((option) => {
				const escapedOption = escapeHtml(option);
				return `<option value="${escapedOption}" ${option === field.value ? 'selected' : ''}>${escapedOption}</option>`;
			}).join('');
			return `
				<div class="property-group">
					<label>${label}</label>
					<select data-prop="${prop}">${options}</select>
				</div>
			`;
		}

		const attrs = [
			`type="${escapeHtml(field.type || 'text')}"`,
			`value="${escapeHtml(field.value)}"`,
			`data-prop="${prop}"`,
		];
		if (field.step !== undefined) attrs.push(`step="${escapeHtml(field.step)}"`);
		if (field.min !== undefined) attrs.push(`min="${escapeHtml(field.min)}"`);
		if (field.max !== undefined) attrs.push(`max="${escapeHtml(field.max)}"`);

		return `
			<div class="property-group">
				<label>${label}</label>
				<input ${attrs.join(' ')}>
			</div>
		`;
	},

	applyClipPropertyInput(input, clip) {
		if (!this.ensureTimelineEditable()) return;
		this.captureEditHistoryOnce(input);

		const prop = input.getAttribute('data-prop');
		let value = input.value;

		if (input.getAttribute('data-json') === 'true') {
			try {
				value = JSON.parse(input.value);
				input.classList.remove('invalid');
			} catch (err) {
				input.classList.add('invalid');
				this.setStatus(prop + ' 不是有效 JSON', 'error', 2000);
				return;
			}
		} else if (input.type === 'checkbox') {
			value = input.checked;
		} else if (input.type === 'number') {
			value = parseFloat(input.value);
			if (!Number.isFinite(value)) {
				this.setStatus(prop + ' 不是有效数字', 'error', 2000);
				return;
			}
		}

		if (prop === 'start') {
			value = clampNumber(value, 0, null, clip.start || 0);
		} else if (prop === 'duration') {
			value = clampNumber(value, 0.01, null, clip.duration || 1);
		} else if (prop === 'volume') {
			value = clampNumber(value, 0, 1, 1);
		} else if (prop === 'trackIndex') {
			value = Math.max(0, parseInt(value, 10) || 0);
		} else if (prop === 'speed') {
			value = clampNumber(value, 0, null, 1);
		}

		clip[prop] = value;
		editorState.timelineData.duration = Math.max(
			editorState.timelineData.duration,
			Math.ceil((clip.start + clip.duration) * 100) / 100
		);
		this.markDirty();
		this.renderTimeline();
	},

	applyTrackPropertyInput(input, track) {
		if (!this.ensureTimelineEditable()) return;
		this.captureEditHistoryOnce(input);

		const prop = input.getAttribute('data-prop');
		let value = input.value;

		if (input.type === 'checkbox') {
			value = input.checked;
		}

		if (prop === 'name') {
			value = value || 'Track';
		} else if (prop === 'targetPath') {
			value = value || '.';
		} else if (prop === 'type') {
			value = CLIP_TYPES.indexOf(value) >= 0 ? value : 'animation';
		}

		track[prop] = value;
		this.markDirty();
		this.renderTimeline();
	},

	renderSelectedTrackProperties(panel, track, trackIndex) {
		const fields = [
			{ label: '轨道名称', prop: 'name', type: 'text', value: track.name || 'Track ' + (trackIndex + 1) },
			{ label: '默认片段类型', prop: 'type', type: 'select', value: track.type || 'animation', options: CLIP_TYPES },
			{ label: '目标节点路径', prop: 'targetPath', type: 'text', value: track.targetPath || '.' },
			{ label: '启用', prop: 'enabled', type: 'checkbox', value: track.enabled !== false },
			{ label: '锁定', prop: 'locked', type: 'checkbox', value: !!track.locked },
			{ label: '静音', prop: 'muted', type: 'checkbox', value: !!track.muted },
		];

		panel.innerHTML = `
			<div class="clip-property-type">TRACK / NODE</div>
			${fields.map((field) => this.renderClipPropertyField(field)).join('')}
			<div class="property-group property-actions">
				<button id="btnDeleteTrackFromProps" class="btn btn-danger">删除轨道</button>
			</div>
		`;

		panel.querySelector('#btnDeleteTrackFromProps').addEventListener('click', () => {
			this.onDeleteTrack(trackIndex);
		});

		panel.querySelectorAll('input, select, textarea').forEach((input) => {
			input.addEventListener('focus', () => this.captureEditHistoryOnce(input));
			input.addEventListener('blur', () => this.releaseEditHistory(input));
			const eventName = input.type === 'checkbox' ? 'change' : 'input';
			input.addEventListener(eventName, () => {
				this.applyTrackPropertyInput(input, track);
			});
		});
	},

	// 更新片段属性面板
	updateClipProperties() {
		const panel = this.$el('#clipProperties');
		editorState.selectedClips = editorState.selectedClips || [];

		// 多选状态
		if (editorState.selectedClips.length > 1) {
			panel.innerHTML = `
				<div class="property-group">
					<label>已选中 ${editorState.selectedClips.length} 个片段</label>
				</div>
				<div class="property-group property-actions">
					<button id="btnCopyClips" class="btn">复制</button>
					<button id="btnDeleteClips" class="btn btn-danger">删除</button>
				</div>
			`;

			panel.querySelector('#btnCopyClips').addEventListener('click', () => {
				this.copyClip();
			});

			panel.querySelector('#btnDeleteClips').addEventListener('click', () => {
				this.deleteSelectedClips();
			});

			return;
		}

		if (editorState.selectedTrack !== null && editorState.selectedClip === null) {
			const track = editorState.timelineData.tracks[editorState.selectedTrack];
			if (!track) {
				editorState.selectedTrack = null;
				panel.innerHTML = '<div class="empty-state">未选中片段</div>';
				return;
			}
			this.renderSelectedTrackProperties(panel, track, editorState.selectedTrack);
			return;
		}

		if (editorState.selectedTrack === null || editorState.selectedClip === null) {
			panel.innerHTML = '<div class="empty-state">未选中片段</div>';
			return;
		}

		const track = editorState.timelineData.tracks[editorState.selectedTrack];
		if (!track || !track.clips || !track.clips[editorState.selectedClip]) {
			editorState.selectedTrack = null;
			editorState.selectedClip = null;
			editorState.selectedClips = [];
			panel.innerHTML = '<div class="empty-state">未选中片段</div>';
			return;
		}

		const clip = track.clips[editorState.selectedClip];
		const clipType = getClipType(track, clip);
		clip.type = clipType;

		const commonFields = [
			{ label: '片段名称', prop: 'name', type: 'text', value: clip.name || '' },
			{ label: '启用', prop: 'enabled', type: 'checkbox', value: clip.enabled !== false },
			{ label: '开始时间（秒）', prop: 'start', type: 'number', step: '0.01', min: '0', value: clip.start },
			{ label: '持续时间（秒）', prop: 'duration', type: 'number', step: '0.01', min: '0.01', value: clip.duration || 0.01 },
		];
		const fields = commonFields.concat(this.getClipSpecificFields(clipType, clip));

		panel.innerHTML = `
			<div class="clip-property-type">${escapeHtml(clipType.toUpperCase())}</div>
			${fields.map((field) => this.renderClipPropertyField(field)).join('')}
			<div class="property-group property-actions">
				<button id="btnCopyClip" class="btn">复制</button>
				<button id="btnDeleteClip" class="btn btn-danger">删除</button>
			</div>
		`;

		panel.querySelector('#btnCopyClip').addEventListener('click', () => {
			this.copyClip();
		});

		panel.querySelector('#btnDeleteClip').addEventListener('click', () => {
			this.onDeleteClip(editorState.selectedTrack, editorState.selectedClip);
		});

		panel.querySelectorAll('input, select, textarea').forEach((input) => {
			input.addEventListener('focus', () => this.captureEditHistoryOnce(input));
			input.addEventListener('blur', () => this.releaseEditHistory(input));
			const eventName = input.getAttribute('data-json') === 'true' || input.type === 'checkbox' || input.tagName === 'SELECT'
				? 'change'
				: 'input';
			input.addEventListener(eventName, () => {
				this.applyClipPropertyInput(input, clip);
			});
		});
	},

	// 播放控制
	callTimelineSceneScript(method, payload, callback) {
		const done = typeof callback === 'function' ? callback : function () {};

		if (Editor.Scene && typeof Editor.Scene.callSceneScript === 'function') {
			Editor.Scene.callSceneScript('ui-timeline-editor', method, payload || {}, done);
			return;
		}

		if (Editor.Ipc && typeof Editor.Ipc.sendToMain === 'function') {
			Editor.Ipc.sendToMain('ui-timeline-editor:' + method, payload || {}, done);
			return;
		}

		done(null, {
			ok: false,
			warnings: ['当前编辑器不支持 SceneScript 调用'],
		});
	},

	previewTimelineAtCurrentTime(options = {}) {
		if (!editorState.isTimelineEditable || !editorState.timelineData) return;

		const payload = {
			time: editorState.currentTime,
			playing: !!options.playing,
			timelineData: editorState.timelineData,
		};

		if (editorState.scenePreviewInFlight) {
			editorState.scenePreviewPending = payload;
			return;
		}

		editorState.scenePreviewInFlight = true;
		this.callTimelineSceneScript('preview-timeline', payload, (err, result) => {
			editorState.scenePreviewInFlight = false;

			if (err) {
				this.reportScenePreviewWarning(err.message || String(err));
			} else if (result && result.ok === false) {
				this.reportScenePreviewWarning((result.warnings && result.warnings[0]) || '预览失败');
			} else if (result && result.warnings && result.warnings.length > 0) {
				this.reportScenePreviewWarning(result.warnings[0]);
			} else {
				editorState.scenePreviewLastWarning = '';
			}

			editorState.scenePreviewActive = !!(result && result.ok !== false);

			const pending = editorState.scenePreviewPending;
			editorState.scenePreviewPending = null;
			if (pending) {
				this.previewTimelineAtCurrentTime({
					playing: pending.playing,
				});
			}
		});
	},

	reportScenePreviewWarning(message) {
		if (!message || message === editorState.scenePreviewLastWarning) return;
		editorState.scenePreviewLastWarning = message;
		this.setStatus('预览提示: ' + message, 'error', 2000);
	},

	stopScenePreview(callback) {
		editorState.scenePreviewPending = null;
		editorState.scenePreviewLastWarning = '';
		this.callTimelineSceneScript('stop-preview', {}, (err, result) => {
			editorState.scenePreviewActive = false;
			if (err) {
				this.reportScenePreviewWarning(err.message || String(err));
			} else if (result && result.ok === false && result.warnings && result.warnings.length > 0) {
				this.reportScenePreviewWarning(result.warnings[0]);
			}
			if (typeof callback === 'function') {
				callback(err, result);
			}
		});
	},

	startPlayback() {
		if (this.playbackInterval) return;

		const frameRate = Math.max(1, parseInt(editorState.timelineData.frameRate, 10) || 60);
		const intervalMs = Math.max(8, Math.floor(1000 / frameRate));
		editorState.lastPlaybackTime = Date.now();

		this.playbackInterval = setInterval(() => {
			const now = Date.now();
			const delta = Math.max(0, (now - editorState.lastPlaybackTime) / 1000);
			editorState.lastPlaybackTime = now;
			this.advancePlayback(delta);
		}, intervalMs);
	},

	advancePlayback(delta) {
		const duration = clampNumber(editorState.timelineData.duration, 0.01, null, 5.0);
		const loopMode = editorState.timelineData.loopMode || 'none';
		const direction = editorState.playbackDirection || 1;
		let nextTime = editorState.currentTime + delta * direction;

		if (loopMode === 'loop') {
			while (nextTime >= duration) nextTime -= duration;
			while (nextTime < 0) nextTime += duration;
		} else if (loopMode === 'pingpong') {
			if (nextTime >= duration) {
				nextTime = duration - (nextTime - duration);
				editorState.playbackDirection = -1;
			}
			if (nextTime <= 0) {
				nextTime = -nextTime;
				editorState.playbackDirection = 1;
			}
			nextTime = Math.max(0, Math.min(duration, nextTime));
		} else if (nextTime >= duration || nextTime <= 0) {
			nextTime = direction >= 0 ? duration : 0;
			editorState.isPlaying = false;
			this.setPlayButtonIcon(false);
			this.stopPlayback();
		}

		editorState.currentTime = Math.max(0, Math.min(duration, nextTime));
		this.updatePlayhead();
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
			const data = normalizeTimelineData(JSON.parse(content), Path.basename(filePath, '.json'));

			this.stopPlayback();
			editorState.timelineData = data;
			editorState.currentFile = filePath;
			editorState.selectedTrack = null;
			editorState.selectedClip = null;
			editorState.selectedClips = [];
			editorState.currentTime = 0;
			editorState.playbackDirection = 1;
			editorState.isPlaying = false;
			editorState.isDirty = false;
			this.setPlayButtonIcon(false);

			// 初始化历史记录
			this.clearHistory();
			this.pushHistory();

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

			editorState.timelineData = normalizeTimelineData(editorState.timelineData, Path.basename(filePath, '.json'));
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
	captureEditHistoryOnce(input) {
		if (!input || !editorState.timelineData || input.getAttribute('data-history-captured') === 'true') {
			return;
		}
		this.pushHistory();
		input.setAttribute('data-history-captured', 'true');
	},

	releaseEditHistory(input) {
		if (input) {
			input.removeAttribute('data-history-captured');
		}
	},

	markDirty() {
		editorState.isDirty = true;
	},

	// 历史记录管理
	pushHistory() {
		if (!editorState.timelineData) return;

		// 深拷贝当前状态
		const snapshot = JSON.parse(JSON.stringify(editorState.timelineData));

		// 如果当前不在历史记录末尾，删除后面的记录
		if (editorState.historyIndex < editorState.history.length - 1) {
			editorState.history.splice(editorState.historyIndex + 1);
		}

		// 添加新快照
		editorState.history.push(snapshot);

		// 限制历史记录大小
		if (editorState.history.length > editorState.maxHistorySize) {
			editorState.history.shift();
		} else {
			editorState.historyIndex++;
		}

		this.updateUndoRedoButtons();
	},

	undo() {
		if (!this.canUndo()) return;

		editorState.historyIndex--;
		this.restoreFromHistory();
		this.setStatus('已撤销', 'info', 1000);
	},

	redo() {
		if (!this.canRedo()) return;

		editorState.historyIndex++;
		this.restoreFromHistory();
		this.setStatus('已重做', 'info', 1000);
	},

	canUndo() {
		return editorState.historyIndex > 0;
	},

	canRedo() {
		return editorState.historyIndex < editorState.history.length - 1;
	},

	restoreFromHistory() {
		if (editorState.historyIndex < 0 || editorState.historyIndex >= editorState.history.length) {
			return;
		}

		// 恢复快照（深拷贝）
		editorState.timelineData = normalizeTimelineData(cloneData(editorState.history[editorState.historyIndex]), editorState.timelineData && editorState.timelineData.name);
		editorState.isDirty = true;
		editorState.selectedTrack = null;
		editorState.selectedClip = null;
		editorState.selectedClips = [];

		// 更新界面
		this.renderTimeline();
		this.updateUI();
		this.updateClipProperties();
		this.updateUndoRedoButtons();
	},

	updateUndoRedoButtons() {
		const btnUndo = this.$el('#btnUndo');
		const btnRedo = this.$el('#btnRedo');

		if (btnUndo) {
			btnUndo.disabled = !editorState.isTimelineEditable || !this.canUndo();
		}
		if (btnRedo) {
			btnRedo.disabled = !editorState.isTimelineEditable || !this.canRedo();
		}
	},

	clearHistory() {
		editorState.history = [];
		editorState.historyIndex = -1;
		this.updateUndoRedoButtons();
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
