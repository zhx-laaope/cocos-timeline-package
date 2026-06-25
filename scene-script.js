'use strict';

const previewState = {
	active: false,
	snapshots: Object.create(null),
	lastTriggeredKeys: Object.create(null),
	lastTime: null,
};

function pushUnique(list, value) {
	if (!value || typeof value !== 'string') return;
	if (list.indexOf(value) === -1) {
		list.push(value);
	}
}

function collectUuidCandidates(value, list, visited, depth) {
	if (!value || depth > 3) return;

	if (typeof value === 'string') {
		pushUnique(list, value);
		return;
	}

	if (typeof value !== 'object') return;
	if (visited.indexOf(value) !== -1) return;
	visited.push(value);

	const directKeys = [
		'uuid',
		'_uuid',
		'assetUuid',
		'_assetUuid',
		'prefabUuid',
		'_prefabUuid',
		'assetId',
		'_assetId',
		'id',
		'_id',
	];

	for (const key of directKeys) {
		if (typeof value[key] === 'string') {
			pushUnique(list, value[key]);
		}
	}

	const nestedKeys = [
		'asset',
		'_asset',
		'prefabAsset',
		'_prefabAsset',
		'prefab',
		'_prefab',
		'root',
		'_root',
		'data',
		'_data',
	];

	for (const key of nestedKeys) {
		if (value[key]) {
			collectUuidCandidates(value[key], list, visited, depth + 1);
		}
	}
}

function getEditableRootNode() {
	const scene = cc.director.getScene();
	if (!scene || !scene.children) return null;

	const roots = scene.children.filter((node) => {
		if (!node || !node.name) return false;
		return node.name !== 'gizmoRoot' && !/^Editor Scene/.test(node.name);
	});

	if (roots.length === 1) return roots[0];
	return roots.find((node) => !!node._prefab) || roots[0] || null;
}

function getPrefabContext() {
	const result = {
		inPrefab: false,
		modeName: '',
		rootName: '',
		rootUuid: '',
		candidateUuids: [],
	};

	try {
		const editMode = Editor.require('scene://edit-mode');
		const mode = editMode && editMode.curMode ? editMode.curMode() : null;
		result.modeName = mode && mode.name ? mode.name : '';

		if (!mode || mode.name !== 'prefab') {
			return result;
		}

		result.inPrefab = true;

		const root = getEditableRootNode();
		if (root) {
			result.rootName = root.name || '';
			result.rootUuid = root.uuid || '';
			collectUuidCandidates(root._prefab, result.candidateUuids, [], 0);
		}

		collectUuidCandidates(mode, result.candidateUuids, [], 0);
	} catch (err) {
		result.inPrefab = false;
		result.reason = err.message || String(err);
	}

	return result;
}

function reply(event, err, data) {
	if (event && event.reply) {
		event.reply(err, data);
	}
}

function cloneColor(color) {
	if (!color) return null;
	return {
		r: color.r,
		g: color.g,
		b: color.b,
		a: color.a,
	};
}

function isFiniteNumber(value) {
	const number = Number(value);
	return Number.isFinite ? Number.isFinite(number) : isFinite(number);
}

function getNodeRotation(node) {
	if (!node) return 0;
	if (typeof node.angle === 'number') return -node.angle;
	if (typeof node.rotation === 'number') return node.rotation;
	return 0;
}

function setNodeRotation(node, value) {
	if (!node || !isFiniteNumber(value)) return false;
	const number = Number(value);
	if (typeof node.angle === 'number') {
		node.angle = -number;
		return true;
	}
	if (typeof node.rotation !== 'undefined') {
		node.rotation = number;
		return true;
	}
	return false;
}

function getNodeAngle(node) {
	if (!node) return 0;
	if (typeof node.angle === 'number') return node.angle;
	return -getNodeRotation(node);
}

function setNodeAngle(node, value) {
	if (!node || !isFiniteNumber(value)) return false;
	const number = Number(value);
	if (typeof node.angle === 'number') {
		node.angle = number;
		return true;
	}
	return setNodeRotation(node, -number);
}

function snapshotNode(node) {
	if (!node || !node.uuid) return;
	if (previewState.snapshots[node.uuid]) return;

	previewState.snapshots[node.uuid] = {
		node,
		active: node.active,
		x: node.x,
		y: node.y,
		scaleX: node.scaleX,
		scaleY: node.scaleY,
		rotation: getNodeRotation(node),
		angle: getNodeAngle(node),
		opacity: node.opacity,
		width: node.width,
		height: node.height,
		color: cloneColor(node.color),
	};
}

function restoreSnapshotValues() {
	Object.keys(previewState.snapshots).forEach((uuid) => {
		const snapshot = previewState.snapshots[uuid];
		const node = snapshot && snapshot.node;
		if (!node || !node.isValid) return;

		node.active = snapshot.active;
		node.x = snapshot.x;
		node.y = snapshot.y;
		node.scaleX = snapshot.scaleX;
		node.scaleY = snapshot.scaleY;
		setNodeRotation(node, snapshot.rotation);
		node.opacity = snapshot.opacity;
		node.width = snapshot.width;
		node.height = snapshot.height;
		if (snapshot.color && cc.Color) {
			node.color = new cc.Color(snapshot.color.r, snapshot.color.g, snapshot.color.b, snapshot.color.a);
		}
		resetNodeSampledState(node);
	});
}

function restorePreviewState() {
	restoreSnapshotValues();

	previewState.active = false;
	previewState.snapshots = Object.create(null);
	previewState.lastTriggeredKeys = Object.create(null);
	previewState.lastTime = null;
}

function findChildByName(node, name) {
	if (!node || !node.children) return null;
	for (let i = 0; i < node.children.length; i++) {
		if (node.children[i] && node.children[i].name === name) {
			return node.children[i];
		}
	}
	return null;
}

function resolveTargetNode(root, targetPath) {
	if (!root) return null;
	const rawPath = targetPath || '.';
	if (rawPath === '.' || rawPath === './' || rawPath === '') return root;

	let current = root;
	const segments = rawPath.split('/').filter((segment) => !!segment && segment !== '.');
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		if (segment === '..') {
			current = current.parent || current;
			continue;
		}
		current = findChildByName(current, segment);
		if (!current) return null;
	}
	return current;
}

function parseColor(value) {
	if (!value) return null;
	if (value instanceof cc.Color) return value;
	if (typeof value === 'string') {
		const match = value.trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{8})$/i);
		if (!match) return null;
		const hex = match[1];
		const r = parseInt(hex.slice(0, 2), 16);
		const g = parseInt(hex.slice(2, 4), 16);
		const b = parseInt(hex.slice(4, 6), 16);
		const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255;
		return new cc.Color(r, g, b, a);
	}
	if (typeof value === 'object') {
		return new cc.Color(
			Number(value.r) || 0,
			Number(value.g) || 0,
			Number(value.b) || 0,
			value.a === undefined ? 255 : Number(value.a) || 0
		);
	}
	return null;
}

function lerpNumber(from, to, progress) {
	return from + (to - from) * progress;
}

function bezierNumber(c1, c2, c3, c4, progress) {
	const t = clamp01(progress);
	const t1 = 1 - t;
	return t1 * (t1 * (c1 + (c2 * 3 - c1) * t) + c3 * 3 * t * t) + c4 * t * t * t;
}

function readTweenVec2(value, fallback) {
	const source = value && typeof value === 'object' ? value : {};
	return {
		x: Number(source.x === undefined ? fallback.x : source.x) || 0,
		y: Number(source.y === undefined ? fallback.y : source.y) || 0,
	};
}

function clamp01(value) {
	const number = Number(value);
	if (!isFiniteNumber(number)) return 0;
	return Math.max(0, Math.min(1, number));
}

function easeTween(name, progress) {
	const t = clamp01(progress);
	switch (name) {
		case 'sineIn':
			return 1 - Math.cos((t * Math.PI) / 2);
		case 'sineOut':
			return Math.sin((t * Math.PI) / 2);
		case 'sineInOut':
			return -(Math.cos(Math.PI * t) - 1) / 2;
		case 'quadIn':
			return t * t;
		case 'quadOut':
			return 1 - (1 - t) * (1 - t);
		case 'quadInOut':
			return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
		case 'cubicIn':
			return t * t * t;
		case 'cubicOut':
			return 1 - Math.pow(1 - t, 3);
		case 'cubicInOut':
			return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
		case 'backOut': {
			const c1 = 1.70158;
			const c3 = c1 + 1;
			return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
		}
		case 'bounceOut': {
			const n1 = 7.5625;
			const d1 = 2.75;
			if (t < 1 / d1) return n1 * t * t;
			if (t < 2 / d1) return n1 * (t - 1.5 / d1) * (t - 1.5 / d1) + 0.75;
			if (t < 2.5 / d1) return n1 * (t - 2.25 / d1) * (t - 2.25 / d1) + 0.9375;
			return n1 * (t - 2.625 / d1) * (t - 2.625 / d1) + 0.984375;
		}
		default:
			return t;
	}
}

function toPositiveDuration(value) {
	const duration = Number(value);
	return isFiniteNumber(duration) && duration > 0 ? duration : 0;
}

function getClipDurationFromAnimationState(state) {
	if (!state) return 0;
	return toPositiveDuration(state.duration) || toPositiveDuration(state.clip && state.clip.duration);
}

function findAnimationClip(component, name) {
	if (!component || !name) return null;
	if (component.getClips) {
		const clips = component.getClips() || [];
		for (let i = 0; i < clips.length; i++) {
			if (clips[i] && (clips[i].name === name || clips[i]._name === name)) {
				return clips[i];
			}
		}
	}
	const rawClips = component._clips || component.clips || [];
	for (let i = 0; i < rawClips.length; i++) {
		const clip = rawClips[i];
		if (clip && (clip.name === name || clip._name === name)) {
			return clip;
		}
	}
	return null;
}

function getAnimationResourceDuration(node, clip, warnings) {
	const animation = node && node.getComponent && node.getComponent(cc.Animation);
	if (!animation) {
		warnings.push('未找到 cc.Animation: ' + (node && node.name ? node.name : ''));
		return null;
	}
	if (!clip.clipName) {
		warnings.push('Animation 片段缺少 clipName');
		return null;
	}

	const state = animation.getAnimationState ? animation.getAnimationState(clip.clipName) : null;
	const stateDuration = getClipDurationFromAnimationState(state);
	if (stateDuration > 0) {
		return {
			duration: stateDuration,
			source: 'Animation:' + clip.clipName,
		};
	}

	const animationClip = findAnimationClip(animation, clip.clipName);
	const clipDuration = toPositiveDuration(animationClip && animationClip.duration);
	if (clipDuration > 0) {
		return {
			duration: clipDuration,
			source: 'Animation:' + clip.clipName,
		};
	}

	warnings.push('Animation 剪辑不存在或时长无效: ' + clip.clipName);
	return null;
}

function findSpineAnimation(skeleton, name) {
	if (!skeleton || !name) return null;
	if (skeleton.findAnimation) {
		const animation = skeleton.findAnimation(name);
		if (animation) return animation;
	}
	const runtimeData = skeleton.skeletonData && skeleton.skeletonData.getRuntimeData
		? skeleton.skeletonData.getRuntimeData()
		: null;
	if (runtimeData && runtimeData.findAnimation) {
		const animation = runtimeData.findAnimation(name);
		if (animation) return animation;
	}
	if (skeleton._skeleton && skeleton._skeleton.data && skeleton._skeleton.data.findAnimation) {
		return skeleton._skeleton.data.findAnimation(name);
	}
	return null;
}

function getSpineResourceDuration(node, clip, warnings) {
	if (typeof sp === 'undefined' || !sp.Skeleton) {
		warnings.push('当前环境未加载 Spine');
		return null;
	}
	const skeleton = node && node.getComponent && node.getComponent(sp.Skeleton);
	if (!skeleton) {
		warnings.push('未找到 sp.Skeleton: ' + (node && node.name ? node.name : ''));
		return null;
	}
	if (!clip.animName) {
		warnings.push('Spine 片段缺少 animName');
		return null;
	}

	const animation = findSpineAnimation(skeleton, clip.animName);
	const duration = toPositiveDuration(animation && animation.duration);
	if (duration > 0) {
		return {
			duration,
			source: 'Spine:' + clip.animName,
		};
	}

	warnings.push('Spine 动画不存在或时长无效: ' + clip.animName);
	return null;
}

function normalizeAudioResourceUrl(url) {
	let result = String(url || '').trim();
	if (!result) return '';
	result = result.replace(/^db:\/\/assets\/resources\//i, '');
	result = result.replace(/^assets\/resources\//i, '');
	result = result.replace(/\.(mp3|ogg|wav|m4a)$/i, '');
	return result;
}

function queryAudioResourceDuration(clip, warnings, callback) {
	const audioUrl = normalizeAudioResourceUrl(clip.audioUrl);
	if (!audioUrl) {
		warnings.push('Audio 片段缺少 audioUrl');
		callback(null);
		return;
	}

	const onLoaded = (err, audioClip) => {
		if (err || !audioClip) {
			warnings.push('Audio 资源加载失败: ' + audioUrl);
			callback(null);
			return;
		}
		const duration = toPositiveDuration(audioClip.duration);
		if (duration <= 0) {
			warnings.push('Audio 资源时长无效: ' + audioUrl);
			callback(null);
			return;
		}
		callback({
			duration,
			source: 'Audio:' + audioUrl,
		});
	};

	try {
		if (cc.loader && cc.loader.loadRes) {
			cc.loader.loadRes(audioUrl, cc.AudioClip, onLoaded);
			return;
		}
		if (cc.resources && cc.resources.load) {
			cc.resources.load(audioUrl, cc.AudioClip, onLoaded);
			return;
		}
		warnings.push('当前环境不支持加载 AudioClip');
		callback(null);
	} catch (err) {
		warnings.push('Audio 资源加载异常: ' + (err && err.message ? err.message : String(err)));
		callback(null);
	}
}

function isTweenActionClip(clip) {
	return !!(clip && (Array.isArray(clip.actions) || (clip.actions && typeof clip.actions === 'object')));
}

function asTweenActionArray(actions) {
	if (Array.isArray(actions)) return actions;
	if (actions && typeof actions === 'object') return [actions];
	return [];
}

function getTweenActionChildren(action) {
	if (!action || typeof action !== 'object') return [];
	if (Array.isArray(action.actions)) return action.actions;
	if (Array.isArray(action.sequence)) return action.sequence;
	if (Array.isArray(action.parallel)) return action.parallel;
	if (action.action && typeof action.action === 'object') return [action.action];
	return [];
}

function getTweenActionDuration(action, fallbackDuration) {
	if (!action || typeof action !== 'object') return 0;
	const type = action.type || 'to';
	const duration = Math.max(0, Number(action.duration) || 0);

	if (type === 'sequence' || type === 'then') {
		return getTweenActionsDuration(getTweenActionChildren(action), fallbackDuration);
	}
	if (type === 'parallel' || type === 'spawn') {
		return getTweenActionChildren(action).reduce((max, child) => {
			return Math.max(max, getTweenActionDuration(child, fallbackDuration));
		}, 0);
	}
	if (type === 'repeat') {
		return getTweenActionsDuration(getTweenActionChildren(action), fallbackDuration) * Math.max(0, parseInt(action.times, 10) || 0);
	}
	if (type === 'repeatForever') {
		return duration || Math.max(0, Number(fallbackDuration) || 0);
	}
	if (type === 'reverseTime') {
		return getTweenActionsDuration(getTweenActionChildren(action), fallbackDuration);
	}
	if (type === 'delay' || type === 'to' || type === 'by' || type === 'blink' || type === 'bezierTo' || type === 'bezierBy') {
		return duration;
	}
	return 0;
}

function getTweenActionsDuration(actions, fallbackDuration) {
	return asTweenActionArray(actions).reduce((total, action) => {
		return total + getTweenActionDuration(action, fallbackDuration);
	}, 0);
}

function getTweenClipActions(clip) {
	const actions = isTweenActionClip(clip) ? asTweenActionArray(clip.actions) : [];
	return actions.length > 0 ? actions : [{ type: 'delay', duration: Number(clip.duration) || 0 }];
}

function cloneTweenValue(value) {
	if (value && value instanceof cc.Color) {
		return new cc.Color(value.r, value.g, value.b, value.a);
	}
	if (value && typeof value === 'object') {
		if (value.r !== undefined && value.g !== undefined && value.b !== undefined) {
			return {
				r: value.r,
				g: value.g,
				b: value.b,
				a: value.a,
			};
		}
		if (value.x !== undefined || value.y !== undefined || value.z !== undefined) {
			return {
				x: Number(value.x) || 0,
				y: Number(value.y) || 0,
				z: Number(value.z) || 0,
			};
		}
	}
	return value;
}

function getTweenPropValue(node, prop) {
	if (prop === 'active') return node.active;
	if (prop === 'rotation') return getNodeRotation(node);
	if (prop === 'angle') return getNodeAngle(node);
	if (prop === 'position') {
		return { x: Number(node.x) || 0, y: Number(node.y) || 0, z: Number(node.z) || 0 };
	}
	if (prop === 'scale') {
		if (typeof node.scale !== 'undefined') return node.scale;
		return { x: Number(node.scaleX) || 0, y: Number(node.scaleY) || 0 };
	}
	if (prop === 'color') return cloneColor(node.color);
	return cloneTweenValue(node[prop]);
}

function setTweenPropValue(node, prop, value) {
	if (prop === 'active') {
		node.active = !!value;
		return true;
	}
	if (prop === 'rotation') return setNodeRotation(node, value);
	if (prop === 'angle') return setNodeAngle(node, value);
	if (prop === 'position') {
		if (!value || typeof value !== 'object') return false;
		if (value.x !== undefined) node.x = Number(value.x) || 0;
		if (value.y !== undefined) node.y = Number(value.y) || 0;
		if (value.z !== undefined && typeof node.z !== 'undefined') node.z = Number(value.z) || 0;
		return true;
	}
	if (prop === 'scale') {
		if (typeof value === 'number') {
			if (typeof node.scale !== 'undefined') node.scale = value;
			if (typeof node.scaleX !== 'undefined') node.scaleX = value;
			if (typeof node.scaleY !== 'undefined') node.scaleY = value;
			return true;
		}
		if (value && typeof value === 'object') {
			if (value.x !== undefined && typeof node.scaleX !== 'undefined') node.scaleX = Number(value.x) || 0;
			if (value.y !== undefined && typeof node.scaleY !== 'undefined') node.scaleY = Number(value.y) || 0;
			return true;
		}
		return false;
	}
	if (prop === 'color') {
		const color = parseColor(value);
		if (!color) return false;
		node.color = color;
		return true;
	}
	if (typeof node[prop] === 'undefined') return false;
	node[prop] = value;
	return true;
}

function addTweenValues(fromValue, deltaValue) {
	const fromNumber = Number(fromValue);
	const deltaNumber = Number(deltaValue);
	if (isFiniteNumber(fromNumber) && isFiniteNumber(deltaNumber)) {
		return fromNumber + deltaNumber;
	}

	const fromColor = parseColor(fromValue);
	const deltaColor = parseColor(deltaValue);
	if (fromColor && deltaColor) {
		return new cc.Color(
			fromColor.r + deltaColor.r,
			fromColor.g + deltaColor.g,
			fromColor.b + deltaColor.b,
			fromColor.a + deltaColor.a
		);
	}

	if (fromValue && deltaValue && typeof fromValue === 'object' && typeof deltaValue === 'object') {
		return {
			x: (Number(fromValue.x) || 0) + (Number(deltaValue.x) || 0),
			y: (Number(fromValue.y) || 0) + (Number(deltaValue.y) || 0),
			z: (Number(fromValue.z) || 0) + (Number(deltaValue.z) || 0),
		};
	}

	return deltaValue;
}

function interpolateTweenValue(fromValue, toValue, progress) {
	if (typeof toValue === 'boolean') return toValue;

	const fromColor = parseColor(fromValue);
	const toColor = parseColor(toValue);
	if (fromColor && toColor) {
		return new cc.Color(
			Math.round(lerpNumber(fromColor.r, toColor.r, progress)),
			Math.round(lerpNumber(fromColor.g, toColor.g, progress)),
			Math.round(lerpNumber(fromColor.b, toColor.b, progress)),
			Math.round(lerpNumber(fromColor.a, toColor.a, progress))
		);
	}

	const fromNumber = Number(fromValue);
	const toNumber = Number(toValue);
	if (isFiniteNumber(fromNumber) && isFiniteNumber(toNumber)) {
		return lerpNumber(fromNumber, toNumber, progress);
	}

	if (fromValue && toValue && typeof fromValue === 'object' && typeof toValue === 'object') {
		return {
			x: lerpNumber(Number(fromValue.x) || 0, Number(toValue.x) || 0, progress),
			y: lerpNumber(Number(fromValue.y) || 0, Number(toValue.y) || 0, progress),
			z: lerpNumber(Number(fromValue.z) || 0, Number(toValue.z) || 0, progress),
		};
	}

	return progress >= 1 ? toValue : fromValue;
}

function getTweenPropSpec(rawValue) {
	if (rawValue && typeof rawValue === 'object' && rawValue.value !== undefined && (rawValue.easing || rawValue.progress)) {
		return {
			value: rawValue.value,
			easing: rawValue.easing,
		};
	}
	return {
		value: rawValue,
		easing: null,
	};
}

function collectTweenActionProps(action, props) {
	if (!action || typeof action !== 'object') return props;
	const type = action.type || 'to';
	if (type === 'to' || type === 'by' || type === 'set') {
		Object.keys(action.props || {}).forEach((prop) => {
			props[prop] = true;
		});
	}
	if (type === 'show' || type === 'hide' || type === 'removeSelf') props.active = true;
	if (type === 'flipX') props.scaleX = true;
	if (type === 'flipY') props.scaleY = true;
	if (type === 'blink') props.opacity = true;
	if (type === 'bezierTo' || type === 'bezierBy') props.position = true;
	getTweenActionChildren(action).forEach((child) => collectTweenActionProps(child, props));
	return props;
}

function captureTweenProps(node, props) {
	const snapshot = Object.create(null);
	Object.keys(props).forEach((prop) => {
		snapshot[prop] = cloneTweenValue(getTweenPropValue(node, prop));
	});
	return snapshot;
}

function applyTweenProps(node, values) {
	Object.keys(values).forEach((prop) => {
		setTweenPropValue(node, prop, cloneTweenValue(values[prop]));
	});
}

function applyTweenPropertyAction(node, action, localTime, warnings) {
	const type = action.type || 'to';
	const props = action.props && typeof action.props === 'object' ? action.props : {};
	const from = action.from && typeof action.from === 'object' ? action.from : {};
	const duration = Math.max(0.0001, Number(action.duration) || 0.0001);
	const normalized = clamp01(localTime / duration);

	Object.keys(props).forEach((prop) => {
		const spec = getTweenPropSpec(props[prop]);
		const fromValue = Object.prototype.hasOwnProperty.call(from, prop)
			? from[prop]
			: getTweenPropValue(node, prop);
		const endValue = type === 'by'
			? addTweenValues(fromValue, spec.value)
			: spec.value;
		const progress = easeTween(spec.easing || action.easing, normalized);
		if (!setTweenPropValue(node, prop, interpolateTweenValue(fromValue, endValue, progress))) {
			warnings.push('Tween 属性不可预览: ' + prop);
		}
	});
}

function applyTweenBezierAction(node, action, localTime, warnings) {
	const type = action.type || 'bezierTo';
	const duration = Math.max(0.0001, Number(action.duration) || 0.0001);
	const progress = easeTween(action.easing, clamp01(localTime / duration));
	const start = getTweenPropValue(node, 'position');
	const c1 = readTweenVec2(action.c1 || action.control1, { x: 0, y: 100 });
	const c2 = readTweenVec2(action.c2 || action.control2, { x: 100, y: 100 });
	const end = readTweenVec2(action.to || action.end || action.position, { x: 100, y: 0 });
	const control1 = type === 'bezierBy' ? addTweenValues(start, c1) : c1;
	const control2 = type === 'bezierBy' ? addTweenValues(start, c2) : c2;
	const target = type === 'bezierBy' ? addTweenValues(start, end) : end;
	const value = {
		x: bezierNumber(start.x, control1.x, control2.x, target.x, progress),
		y: bezierNumber(start.y, control1.y, control2.y, target.y, progress),
	};
	if (!setTweenPropValue(node, 'position', value)) {
		warnings.push('Tween 贝塞尔路径不可预览');
	}
}

function applyTweenInstantAction(node, action, localTime, warnings) {
	if (localTime < 0) return;
	const type = action.type || 'set';
	if (type === 'set') {
		const props = action.props && typeof action.props === 'object' ? action.props : {};
		Object.keys(props).forEach((prop) => {
			if (!setTweenPropValue(node, prop, props[prop])) {
				warnings.push('Tween 属性不可设置: ' + prop);
			}
		});
		return;
	}
	if (type === 'show') {
		node.active = true;
		return;
	}
	if (type === 'hide') {
		node.active = false;
		return;
	}
	if (type === 'removeSelf') {
		node.active = false;
		return;
	}
	if (type === 'flipX') {
		node.scaleX *= -1;
		return;
	}
	if (type === 'flipY') {
		node.scaleY *= -1;
	}
}

function applyTweenCallAction(node, action, warnings, context, path) {
	if (!context || !context.playing) return;
	const key = context.keyPrefix + ':call:' + path;
	if (previewState.lastTriggeredKeys[key]) return;
	previewState.lastTriggeredKeys[key] = true;
	triggerCodeClip(node, {
		callbackName: action.callbackName || action.name,
		params: Array.isArray(action.params) ? action.params : [],
	}, warnings);
}

function applyTweenParallelAction(node, action, localTime, warnings, fallbackDuration, context, path) {
	const children = getTweenActionChildren(action);
	if (children.length === 0) return;
	const propSet = Object.create(null);
	children.forEach((child) => collectTweenActionProps(child, propSet));
	const baseline = captureTweenProps(node, propSet);
	const merged = Object.assign(Object.create(null), baseline);

	children.forEach((child, index) => {
		applyTweenProps(node, baseline);
		applyTweenAction(node, child, Math.min(localTime, getTweenActionDuration(child, fallbackDuration)), warnings, fallbackDuration, context, path + '.p' + index);
		const childProps = collectTweenActionProps(child, Object.create(null));
		Object.keys(childProps).forEach((prop) => {
			merged[prop] = cloneTweenValue(getTweenPropValue(node, prop));
		});
	});

	applyTweenProps(node, merged);
}

function applyTweenRepeatAction(node, action, localTime, warnings, fallbackDuration, context, path) {
	const children = getTweenActionChildren(action);
	const childDuration = getTweenActionsDuration(children, fallbackDuration);
	const times = Math.max(0, parseInt(action.times, 10) || 0);
	if (children.length === 0 || times <= 0) return;
	if (childDuration <= 0) {
		applyTweenActionList(node, children, 0, warnings, fallbackDuration, context, path + '.r0');
		return;
	}
	const completed = Math.min(times, Math.floor(Math.max(0, localTime) / childDuration));
	for (let i = 0; i < completed; i++) {
		applyTweenActionList(node, children, childDuration, warnings, fallbackDuration, context, path + '.r' + i);
	}
	if (completed < times) {
		applyTweenActionList(node, children, Math.max(0, localTime - completed * childDuration), warnings, fallbackDuration, context, path + '.r' + completed);
	}
}

function applyTweenRepeatForeverAction(node, action, localTime, warnings, fallbackDuration, context, path) {
	const children = getTweenActionChildren(action);
	const childDuration = getTweenActionsDuration(children, fallbackDuration);
	if (children.length === 0) return;
	if (childDuration <= 0) {
		applyTweenActionList(node, children, 0, warnings, fallbackDuration, context, path + '.rf0');
		return;
	}
	const loops = Math.min(10000, Math.floor(Math.max(0, localTime) / childDuration));
	for (let i = 0; i < loops; i++) {
		applyTweenActionList(node, children, childDuration, warnings, fallbackDuration, context, path + '.rf' + i);
	}
	applyTweenActionList(node, children, Math.max(0, localTime - loops * childDuration), warnings, fallbackDuration, context, path + '.rf' + loops);
}

function applyTweenAction(node, action, localTime, warnings, fallbackDuration, context, path) {
	if (!action || typeof action !== 'object') return;
	const type = action.type || 'to';
	const duration = getTweenActionDuration(action, fallbackDuration);
	const clampedTime = Math.max(0, Math.min(localTime, duration || 0));

	if (type === 'delay') return;
	if (type === 'call') {
		if (localTime >= 0) applyTweenCallAction(node, action, warnings, context, path || 'call');
		return;
	}
	if (type === 'to' || type === 'by') {
		applyTweenPropertyAction(node, action, clampedTime, warnings);
		return;
	}
	if (type === 'bezierTo' || type === 'bezierBy') {
		applyTweenBezierAction(node, action, clampedTime, warnings);
		return;
	}
	if (type === 'set' || type === 'show' || type === 'hide' || type === 'flipX' || type === 'flipY' || type === 'removeSelf') {
		applyTweenInstantAction(node, action, localTime, warnings);
		return;
	}
	if (type === 'blink') {
		const times = Math.max(1, parseInt(action.times, 10) || 1);
		const slice = 1 / times;
		const t = duration > 0 ? clamp01(clampedTime / duration) : 1;
		node.opacity = t >= 1 ? getTweenPropValue(node, 'opacity') : ((t % slice) > slice / 2 ? 255 : 0);
		return;
	}
	if (type === 'sequence' || type === 'then') {
		applyTweenActionList(node, getTweenActionChildren(action), clampedTime, warnings, fallbackDuration, context, path);
		return;
	}
	if (type === 'parallel' || type === 'spawn') {
		applyTweenParallelAction(node, action, clampedTime, warnings, fallbackDuration, context, path || 'parallel');
		return;
	}
	if (type === 'repeat') {
		applyTweenRepeatAction(node, action, clampedTime, warnings, fallbackDuration, context, path || 'repeat');
		return;
	}
	if (type === 'repeatForever') {
		applyTweenRepeatForeverAction(node, action, clampedTime, warnings, fallbackDuration, context, path || 'repeatForever');
		return;
	}
	if (type === 'reverseTime') {
		const children = getTweenActionChildren(action);
		const childDuration = getTweenActionsDuration(children, fallbackDuration);
		applyTweenActionList(node, children, Math.max(0, childDuration - clampedTime), warnings, fallbackDuration, context, path || 'reverseTime');
	}
}

function applyTweenActionList(node, actions, localTime, warnings, fallbackDuration, context, pathPrefix) {
	let cursor = Math.max(0, localTime);
	asTweenActionArray(actions).forEach((action, index) => {
		const duration = getTweenActionDuration(action, fallbackDuration);
		const path = (pathPrefix || 'a') + '.' + index;
		if (duration <= 0) {
			if (cursor >= 0) applyTweenAction(node, action, 0, warnings, fallbackDuration, context, path);
			return;
		}
		if (cursor >= duration) {
			applyTweenAction(node, action, duration, warnings, fallbackDuration, context, path);
			cursor -= duration;
			return;
		}
		if (cursor >= 0) {
			applyTweenAction(node, action, cursor, warnings, fallbackDuration, context, path);
			cursor = -1;
		}
	});
}

function applyTweenClip(node, clip, localTime, warnings, payload, key) {
	applyTweenActionList(node, getTweenClipActions(clip), localTime, warnings, Number(clip.duration) || 0, {
		playing: !!(payload && payload.playing),
		keyPrefix: key || (clip.id || clip.name || 'tween'),
	}, 'root');
}

function getClipSampleTime(clip, localTime, duration) {
	const speed = Number(clip.speed);
	let sampleTime = Math.max(0, localTime * (Number.isFinite(speed) ? speed : 1));
	if (clip.loop && duration > 0) {
		sampleTime = sampleTime % duration;
	} else if (duration > 0) {
		sampleTime = Math.min(sampleTime, duration);
	}
	return sampleTime;
}

function clipContainsTime(clip, time) {
	const start = Number(clip.start) || 0;
	const duration = Math.max(0, Number(clip.duration) || 0);
	return time >= start && time <= start + duration;
}

function shouldTriggerClip(key, clip, payload) {
	if (!payload || !payload.playing) return false;
	if (previewState.lastTriggeredKeys[key]) return false;

	const start = Number(clip.start) || 0;
	const lastTime = previewState.lastTime;
	const time = Number(payload.time) || 0;

	if (lastTime === null || lastTime === undefined) {
		return time >= start;
	}
	if (time >= lastTime) {
		return lastTime <= start && time >= start;
	}

	// Loop/pingpong seek backwards: allow retrigger after wrap.
	return time >= start;
}

function resetNodeSampledState(node) {
	if (!node || !node.getComponent) return;
	const animation = node.getComponent(cc.Animation);
	if (animation && animation.stop) {
		animation.stop();
	}

	const spineNamespace = typeof sp === 'undefined' ? null : sp;
	const Skeleton = spineNamespace && spineNamespace.Skeleton;
	const skeleton = Skeleton ? node.getComponent(Skeleton) : null;
	if (!skeleton) return;
	if (skeleton.clearTracks) {
		skeleton.clearTracks();
	}
	if (skeleton.setToSetupPose) {
		skeleton.setToSetupPose();
	}
}

function sampleAnimationClip(node, clip, localTime, warnings) {
	const animation = node.getComponent && node.getComponent(cc.Animation);
	if (!animation) {
		warnings.push('未找到 cc.Animation: ' + node.name);
		return;
	}
	if (!clip.clipName) {
		warnings.push('Animation 片段缺少 clipName');
		return;
	}
	let state = animation.getAnimationState ? animation.getAnimationState(clip.clipName) : null;
	if (!state && animation.play) {
		state = animation.play(clip.clipName, 0);
	}
	if (!state) {
		warnings.push('Animation 剪辑不存在: ' + clip.clipName);
		return;
	}
	if (state) {
		const speed = Number(clip.speed);
		state.speed = isFiniteNumber(speed) ? speed : 1;
		if (cc.WrapMode) {
			state.wrapMode = clip.loop ? cc.WrapMode.Loop : cc.WrapMode.Normal;
		}
	}
	const duration = Number(state.duration || (state.clip && state.clip.duration) || 0) || 0;
	const sampleTime = getClipSampleTime(clip, localTime, duration);
	if (animation.setCurrentTime) {
		animation.setCurrentTime(sampleTime, clip.clipName);
	}
	if (animation.sample) {
		animation.sample(clip.clipName);
	}
}

function sampleSpineClip(node, clip, localTime, warnings) {
	if (typeof sp === 'undefined' || !sp.Skeleton) {
		warnings.push('当前环境未加载 Spine');
		return;
	}
	const skeleton = node.getComponent && node.getComponent(sp.Skeleton);
	if (!skeleton) {
		warnings.push('未找到 sp.Skeleton: ' + node.name);
		return;
	}
	if (!clip.animName) {
		warnings.push('Spine 片段缺少 animName');
		return;
	}
	const trackIndex = Math.max(0, parseInt(clip.trackIndex, 10) || 0);
	skeleton.timeScale = 1;
	const entry = skeleton.setAnimation(trackIndex, clip.animName, !!clip.loop);
	if (!entry) {
		warnings.push('Spine 动画不存在: ' + clip.animName);
		return;
	}

	const duration = Number(entry.animationEnd || (entry.animation && entry.animation.duration) || 0) || 0;
	const sampleTime = getClipSampleTime(clip, localTime, duration);
	entry.trackTime = sampleTime;
	if (entry.animationLast !== undefined) {
		entry.animationLast = sampleTime;
	}

	const state = skeleton.getState && skeleton.getState();
	if (state && skeleton._skeleton) {
		state.update(0);
		state.apply(skeleton._skeleton);
		skeleton._skeleton.updateWorldTransform();
	} else if (skeleton.update) {
		skeleton.update(0);
	} else if (skeleton.updateWorldTransform) {
		skeleton.updateWorldTransform();
	}
}

function triggerCodeClip(node, clip, warnings) {
	const callbackName = clip.callbackName;
	if (!callbackName) {
		warnings.push('Code 片段缺少 callbackName');
		return;
	}

	const params = Array.isArray(clip.params) ? clip.params : [];
	const components = node.getComponents ? node.getComponents(cc.Component) : [];
	for (let i = 0; i < components.length; i++) {
		const component = components[i];
		if (component && typeof component[callbackName] === 'function') {
			component[callbackName].apply(component, params);
			return;
		}
	}
	warnings.push('未找到回调: ' + callbackName);
}

function applyPreviewTimeline(payload) {
	const result = {
		ok: true,
		applied: 0,
		triggered: 0,
		warnings: [],
	};
	const timeline = payload && payload.timelineData;
	if (!timeline || !Array.isArray(timeline.tracks)) {
		result.ok = false;
		result.warnings.push('Timeline 数据无效');
		return result;
	}

	const root = getEditableRootNode();
	if (!root) {
		result.ok = false;
		result.warnings.push('未找到可预览的根节点');
		return result;
	}

	const time = Math.max(0, Number(payload.time) || 0);
	restoreSnapshotValues();
	previewState.active = true;

	const targetNodes = [];
	timeline.tracks.forEach((track, trackIndex) => {
		if (!track || track.enabled === false || track.muted) return;
		const node = resolveTargetNode(root, track.targetPath || '.');
		if (!node) {
			result.warnings.push('目标节点不存在: ' + (track.targetPath || '.'));
			return;
		}
		snapshotNode(node);
		if (targetNodes.indexOf(node) === -1) {
			resetNodeSampledState(node);
		}
		targetNodes[trackIndex] = node;
	});

	timeline.tracks.forEach((track, trackIndex) => {
		if (!track || track.enabled === false || track.muted) return;

		const node = targetNodes[trackIndex];
		if (!node) return;

		(track.clips || []).forEach((clip, clipIndex) => {
			if (!clip || clip.enabled === false || !clipContainsTime(clip, time)) return;

			const type = clip.type || track.type;
			const localTime = time - (Number(clip.start) || 0);
			const key = trackIndex + ':' + clipIndex + ':' + (clip.id || clip.name || type);

			if (type === 'active') {
				node.active = clip.active !== false;
				result.applied++;
				return;
			}

			if (type === 'tween') {
				applyTweenClip(node, clip, localTime, result.warnings, payload, key);
				result.applied++;
				return;
			}

			if (type === 'animation') {
				sampleAnimationClip(node, clip, localTime, result.warnings);
				result.applied++;
				return;
			}

			if (type === 'spine') {
				sampleSpineClip(node, clip, localTime, result.warnings);
				result.applied++;
				return;
			}

			if (!shouldTriggerClip(key, clip, payload)) return;

			try {
				if (type === 'code') {
					triggerCodeClip(node, clip, result.warnings);
				} else if (type === 'audio') {
					result.warnings.push('Audio 预览暂未支持: ' + (clip.audioUrl || ''));
					previewState.lastTriggeredKeys[key] = true;
					return;
				}
			} catch (err) {
				result.warnings.push((clip.name || type) + ' 触发失败: ' + (err && err.message ? err.message : String(err)));
				previewState.lastTriggeredKeys[key] = true;
				return;
			}

			previewState.lastTriggeredKeys[key] = true;
			result.triggered++;
		});
	});

	previewState.lastTime = time;
	return result;
}

function queryClipDurations(payload, done) {
	const result = {
		ok: true,
		clips: [],
		warnings: [],
	};
	const timeline = payload && payload.timelineData;
	if (!timeline || !Array.isArray(timeline.tracks)) {
		result.ok = false;
		result.warnings.push('Timeline 数据无效');
		done(result);
		return;
	}

	const root = getEditableRootNode();
	if (!root) {
		result.ok = false;
		result.warnings.push('未找到可预览的根节点');
		done(result);
		return;
	}

	let pending = 0;
	let finished = false;
	const finish = () => {
		if (pending > 0 || finished) return;
		finished = true;
		done(result);
	};

	const pushDuration = (trackIndex, clipIndex, type, item) => {
		if (!item || toPositiveDuration(item.duration) <= 0) return;
		result.clips.push({
			trackIndex,
			clipIndex,
			type,
			duration: item.duration,
			source: item.source || type,
		});
	};

	timeline.tracks.forEach((track, trackIndex) => {
		if (!track || !Array.isArray(track.clips)) return;

		let node = null;
		const needsTarget = track.clips.some((clip) => {
			const type = clip && (clip.type || track.type);
			return type === 'animation' || type === 'spine';
		});
		if (needsTarget) {
			node = resolveTargetNode(root, track.targetPath || '.');
			if (!node) {
				result.warnings.push('目标节点不存在: ' + (track.targetPath || '.'));
			}
		}

		track.clips.forEach((clip, clipIndex) => {
			if (!clip) return;
			const type = clip.type || track.type;
			if (type === 'animation') {
				if (!node) return;
				pushDuration(trackIndex, clipIndex, type, getAnimationResourceDuration(node, clip, result.warnings));
				return;
			}
			if (type === 'spine') {
				if (!node) return;
				pushDuration(trackIndex, clipIndex, type, getSpineResourceDuration(node, clip, result.warnings));
				return;
			}
			if (type === 'audio') {
				pending++;
				queryAudioResourceDuration(clip, result.warnings, (item) => {
					pushDuration(trackIndex, clipIndex, type, item);
					pending--;
					finish();
				});
			}
		});
	});

	finish();
}

module.exports = {
	'query-prefab-context'(event) {
		reply(event, null, getPrefabContext());
	},

	'query-clip-durations'(event, payload) {
		try {
			queryClipDurations(payload || {}, (result) => {
				reply(event, null, result);
			});
		} catch (err) {
			reply(event, null, {
				ok: false,
				clips: [],
				warnings: [err && err.message ? err.message : String(err)],
			});
		}
	},

	'preview-timeline'(event, payload) {
		try {
			reply(event, null, applyPreviewTimeline(payload || {}));
		} catch (err) {
			reply(event, null, {
				ok: false,
				applied: 0,
				triggered: 0,
				warnings: [err && err.message ? err.message : String(err)],
			});
		}
	},

	'stop-preview'(event) {
		try {
			restorePreviewState();
			reply(event, null, { ok: true });
		} catch (err) {
			reply(event, null, {
				ok: false,
				warnings: [err && err.message ? err.message : String(err)],
			});
		}
	},
};
