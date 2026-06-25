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

function getSnapshotValue(node, prop) {
	if (!node || !node.uuid) return undefined;
	const snapshot = previewState.snapshots[node.uuid];
	if (!snapshot) return undefined;

	if (prop === 'color' && snapshot.color) {
		return snapshot.color;
	}
	if (prop === 'rotation') return snapshot.rotation;
	if (prop === 'angle') return snapshot.angle;
	return snapshot[prop];
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

function applyTweenValue(node, prop, fromValue, toValue, progress) {
	if (prop === 'color') {
		const fromColor = parseColor(fromValue) || parseColor(getSnapshotValue(node, 'color'));
		const toColor = parseColor(toValue);
		if (!fromColor || !toColor) return false;

		node.color = new cc.Color(
			Math.round(lerpNumber(fromColor.r, toColor.r, progress)),
			Math.round(lerpNumber(fromColor.g, toColor.g, progress)),
			Math.round(lerpNumber(fromColor.b, toColor.b, progress)),
			Math.round(lerpNumber(fromColor.a, toColor.a, progress))
		);
		return true;
	}

	const fromNumber = Number(fromValue);
	const toNumber = Number(toValue);
	if (!isFiniteNumber(fromNumber) || !isFiniteNumber(toNumber)) return false;

	if (prop === 'rotation') {
		return setNodeRotation(node, lerpNumber(fromNumber, toNumber, progress));
	}
	if (prop === 'angle') {
		return setNodeAngle(node, lerpNumber(fromNumber, toNumber, progress));
	}

	if (typeof node[prop] === 'undefined') return false;

	node[prop] = lerpNumber(fromNumber, toNumber, progress);
	return true;
}

function applyTweenClip(node, clip, localTime, warnings) {
	const duration = Math.max(0.0001, Number(clip.duration) || 0.0001);
	const progress = Math.max(0, Math.min(1, localTime / duration));
	const props = clip.props && typeof clip.props === 'object' ? clip.props : {};
	const from = clip.from && typeof clip.from === 'object' ? clip.from : {};

	Object.keys(props).forEach((prop) => {
		let fromValue = Object.prototype.hasOwnProperty.call(from, prop)
			? from[prop]
			: getSnapshotValue(node, prop);
		if (fromValue === undefined && prop === 'rotation') {
			fromValue = getNodeRotation(node);
		} else if (fromValue === undefined && prop === 'angle') {
			fromValue = getNodeAngle(node);
		} else if (fromValue === undefined && typeof node[prop] !== 'undefined') {
			fromValue = node[prop];
		}

		if (!applyTweenValue(node, prop, fromValue, props[prop], progress)) {
			warnings.push('Tween 属性不可预览: ' + prop);
		}
	});
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
				applyTweenClip(node, clip, localTime, result.warnings);
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

module.exports = {
	'query-prefab-context'(event) {
		reply(event, null, getPrefabContext());
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
