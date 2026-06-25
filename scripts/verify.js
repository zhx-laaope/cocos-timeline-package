'use strict';

const Fs = require('fs');
const Path = require('path');
const Vm = require('vm');
const ChildProcess = require('child_process');

const ROOT = Path.resolve(__dirname, '..');

function read(file) {
	return Fs.readFileSync(Path.join(ROOT, file), 'utf8');
}

function checkSyntax(file) {
	ChildProcess.execFileSync(process.execPath, ['--check', Path.join(ROOT, file)], {
		stdio: 'pipe',
	});
}

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

function verifyPackageJson() {
	JSON.parse(read('package.json'));
}

function verifyPanelHelpers() {
	const source = read('panel/index.js');
	const start = source.indexOf('const CLIP_TYPES');
	const end = source.indexOf('function ensureDirectory');
	assert(start >= 0 && end > start, 'panel helper slice not found');

	const sandbox = { exports: {}, console };
	Vm.createContext(sandbox);
	Vm.runInContext(source.slice(start, end) + `
exports.CLIP_TYPES = CLIP_TYPES;
exports.createDefaultClip = createDefaultClip;
exports.normalizeTimelineData = normalizeTimelineData;
exports.getClipType = getClipType;
exports.isResourceDurationClipType = isResourceDurationClipType;
exports.isClipDurationEditable = isClipDurationEditable;
exports.getTweenActionsDuration = getTweenActionsDuration;
exports.syncTweenClipDuration = syncTweenClipDuration;
exports.normalizeTweenActions = normalizeTweenActions;
`, sandbox);

	const { CLIP_TYPES, createDefaultClip, normalizeTimelineData, getClipType, isResourceDurationClipType, isClipDurationEditable, getTweenActionsDuration, syncTweenClipDuration } = sandbox.exports;
	const timeline = normalizeTimelineData({
		duration: 0,
		frameRate: 'bad',
		loopMode: 'bad',
		tracks: [
			{ type: 'audio', clips: [{ start: -1, duration: 0, volume: 9 }] },
			{ clips: [{ name: '<bad>', start: 3, duration: 2 }] },
		],
	}, 'fallback');

	assert(timeline.duration === 5, 'duration did not expand to max clip end');
	assert(timeline.frameRate === 60, 'frameRate fallback failed');
	assert(timeline.loopMode === 'none', 'loopMode fallback failed');
	assert(timeline.tracks[0].clips[0].start === 0, 'clip start clamp failed');
	assert(timeline.tracks[0].clips[0].duration === 0.01, 'clip duration clamp failed');
	assert(timeline.tracks[0].clips[0].volume === 1, 'audio volume clamp failed');
	assert(timeline.tracks[1].clips[0].type === 'animation', 'track type fallback failed');

	const tweenClip = createDefaultClip('tween', 1.25);
	assert(tweenClip.type === 'tween' && tweenClip.start === 1.25 && Array.isArray(tweenClip.actions), 'default tween clip failed');
	assert(!Object.prototype.hasOwnProperty.call(tweenClip, 'props') && !Object.prototype.hasOwnProperty.call(tweenClip, 'from'), 'default tween should not use legacy fields');
	tweenClip.actions = [
		{ type: 'to', duration: 0.25, props: { x: 10 } },
		{ type: 'parallel', actions: [
			{ type: 'to', duration: 0.5, props: { y: 20 } },
			{ type: 'delay', duration: 0.75 },
		] },
	];
	assert(getTweenActionsDuration(tweenClip.actions, 0) === 1, 'tween action duration calculation failed');
	assert(syncTweenClipDuration(tweenClip) === 1 && tweenClip.duration === 1, 'tween duration sync failed');
	const legacyTween = normalizeTimelineData({
		tracks: [{ type: 'tween', clips: [{ type: 'tween', duration: 0.5, props: { x: 12 } }] }],
	}, 'legacy').tracks[0].clips[0];
	assert(Array.isArray(legacyTween.actions) && legacyTween.actions[0].props.x === 12 && legacyTween.duration === 0.5, 'legacy tween should migrate into actions');
	assert(!Object.prototype.hasOwnProperty.call(legacyTween, 'props') && !Object.prototype.hasOwnProperty.call(legacyTween, 'from'), 'legacy tween fields should be removed after migration');
	const animationClip = createDefaultClip('animation', 0);
	assert(animationClip.durationLocked === true, 'resource clips should lock duration');
	assert(getClipType({ type: 'spine' }, {}) === 'spine', 'clip type fallback failed');
	assert(CLIP_TYPES.indexOf('active') === -1, 'active should not be a creatable clip type');
	assert(isResourceDurationClipType('animation') && isResourceDurationClipType('spine') && isResourceDurationClipType('audio'), 'resource duration type detection failed');
	assert(!isClipDurationEditable('animation', animationClip) && !isClipDurationEditable('tween', tweenClip) && !isClipDurationEditable('tween', { props: {} }), 'clip duration editability failed');
	assert(source.indexOf('renderTweenActionEditor') !== -1, 'structured tween action editor missing');
	assert(source.indexOf('旧格式 props') === -1, 'legacy tween property editor should be removed');
	assert(source.indexOf('请选择 \' + type + \' 轨道后再添加该类型片段') === -1, 'track type should not block mixed clip types');
	assert(source.indexOf('剪贴板片段类型与当前轨道类型不一致') === -1, 'paste should allow mixed clip types on a node track');
	assert(source.indexOf('newClip.type = getClipType(track, newClip);') !== -1, 'paste should preserve pasted clip type');
	assert(source.indexOf('setClipSelection(trackIndex, clipIndex') !== -1, 'clip selection helper missing');
	assert(source.indexOf('if (!hasMoved)') !== -1, 'clip click must not be treated as drag');
}

function verifyKeyboardHelpers() {
	const source = read('panel/index.js');
	const start = source.indexOf('function isEditableEventTarget');
	const end = source.indexOf('function createDefaultEditorState');
	assert(start >= 0 && end > start, 'keyboard helper slice not found');
	assert(source.indexOf('if (isEditableKeyboardEvent(e)) return;') !== -1, 'onKeyDown must ignore editable events');

	const sandbox = { exports: {}, console };
	Vm.createContext(sandbox);
	Vm.runInContext(source.slice(start, end) + `
exports.isEditableEventTarget = isEditableEventTarget;
exports.isEditableKeyboardEvent = isEditableKeyboardEvent;
exports.getDeepActiveElement = getDeepActiveElement;
`, sandbox);

	const isEditableEventTarget = sandbox.exports.isEditableEventTarget;
	const isEditableKeyboardEvent = sandbox.exports.isEditableKeyboardEvent;
	const getDeepActiveElement = sandbox.exports.getDeepActiveElement;
	function element(tagName, attrs, parent, contentEditable) {
		return {
			nodeType: 1,
			tagName,
			parentElement: parent || null,
			parentNode: parent || null,
			isContentEditable: !!contentEditable,
			getAttribute(name) {
				return Object.prototype.hasOwnProperty.call(attrs || {}, name) ? attrs[name] : null;
			},
		};
	}

	assert(isEditableEventTarget(element('INPUT')), 'input target should be editable');
	assert(isEditableEventTarget(element('textarea')), 'textarea target should be editable');
	assert(isEditableEventTarget(element('SELECT')), 'select target should be editable');
	assert(isEditableEventTarget(element('DIV', { contenteditable: 'true' })), 'contenteditable target should be editable');
	assert(isEditableEventTarget(element('DIV', { contenteditable: '' })), 'empty contenteditable target should be editable');
	assert(isEditableEventTarget(element('DIV', { role: 'textbox' })), 'textbox role target should be editable');
	assert(isEditableEventTarget(element('SPAN', {}, element('DIV', { contenteditable: 'true' }))), 'child of contenteditable should be editable');
	assert(isEditableEventTarget({ nodeType: 3, parentNode: element('DIV', { role: 'textbox' }) }), 'text node inside textbox should be editable');
	assert(!isEditableEventTarget(element('DIV')), 'plain div should not be editable');
	assert(!isEditableEventTarget(element('DIV', { contenteditable: 'false' })), 'disabled contenteditable should not be editable');
	assert(isEditableKeyboardEvent({
		target: element('DIV'),
		composedPath() {
			return [element('INPUT'), element('DIV')];
		},
	}), 'composed input path should be editable');
	assert(!isEditableKeyboardEvent({
		target: element('DIV'),
		composedPath() {
			return [element('DIV')];
		},
	}), 'plain composed path should not be editable');

	const shadowInput = element('INPUT');
	const shadowHost = element('DIV');
	shadowHost.shadowRoot = { activeElement: shadowInput };
	assert(getDeepActiveElement({ activeElement: shadowHost }) === shadowInput, 'deep active element should resolve shadow input');
	assert(isEditableKeyboardEvent({
		target: Object.assign(element('DIV'), {
			ownerDocument: { activeElement: shadowHost },
		}),
	}), 'active shadow input should be editable');
}

function verifyScenePreview() {
	const code = read('scene-script.js');

	class Color {
		constructor(r, g, b, a = 255) {
			this.r = r;
			this.g = g;
			this.b = b;
			this.a = a;
		}
	}

	class Component {}

	class Animation extends Component {
		constructor() {
			super();
			this.played = [];
			this.stopped = 0;
			this.sampled = [];
			this.currentTimes = Object.create(null);
			this.states = {
				run: { name: 'run', duration: 2, clip: { duration: 2 }, speed: 1, wrapMode: null },
			};
		}

		getAnimationState(name) {
			return this.states[name] || null;
		}

		getClips() {
			return Object.keys(this.states).map((name) => {
				return Object.assign({ name }, this.states[name].clip);
			});
		}

		play(name, startTime = 0) {
			this.played.push({ name, startTime });
			if (!this.states[name]) {
				this.states[name] = { name, duration: 2, clip: { duration: 2 }, speed: 1, wrapMode: null };
			}
			return this.states[name];
		}

		setCurrentTime(time, name) {
			this.currentTimes[name || '*'] = time;
		}

		sample(name) {
			this.sampled.push(name || '*');
		}

		stop() {
			this.stopped++;
		}
	}

	class Skeleton extends Component {
		constructor() {
			super();
			this.calls = [];
			this.entry = null;
			this.timeScale = 1;
			this._skeleton = {
				worldUpdated: 0,
				data: {
					findAnimation(name) {
						return name === 'walk' ? { name, duration: 3 } : null;
					},
				},
				updateWorldTransform() {
					this.worldUpdated++;
				},
			};
			this._state = {
				updated: 0,
				applied: 0,
				update: (dt) => {
					this._state.updated += dt;
				},
				apply: () => {
					this._state.applied++;
				},
			};
		}

		setAnimation(trackIndex, name, loop) {
			this.entry = {
				trackIndex,
				name,
				loop,
				trackTime: 0,
				animationLast: 0,
				animationEnd: 3,
				animation: { duration: 3 },
			};
			this.calls.push(this.entry);
			return this.entry;
		}

		getState() {
			return this._state;
		}

		findAnimation(name) {
			return name === 'walk' ? { name, duration: 3 } : null;
		}

		clearTracks() {
			this.cleared = true;
		}

		setToSetupPose() {
			this.setup = true;
		}
	}

	class CallbackComponent extends Component {
		constructor() {
			super();
			this.calls = [];
		}

		onTweenCall(...args) {
			this.calls.push(args);
		}
	}

	class Node {
		constructor(name) {
			this.name = name;
			this.uuid = 'uuid_' + name;
			this.children = [];
			this.parent = null;
			this.active = true;
			this.x = 0;
			this.y = 0;
			this.scaleX = 1;
			this.scaleY = 1;
			this.angle = 0;
			this.opacity = 255;
			this.width = 100;
			this.height = 100;
			this.color = new Color(255, 255, 255, 255);
			this.isValid = true;
			this._components = [];
			Object.defineProperty(this, 'rotation', {
				get() {
					throw new Error('deprecated rotation getter used');
				},
				set() {
					throw new Error('deprecated rotation setter used');
				},
			});
		}

		addChild(child) {
			child.parent = this;
			this.children.push(child);
			return child;
		}

		addComponent(comp) {
			this._components.push(comp);
			return comp;
		}

		getComponent(klass) {
			return this._components.find((component) => component instanceof klass) || null;
		}

		getComponents() {
			return this._components;
		}
	}

	class AudioClip {}

	const root = new Node('Root');
	const child = root.addChild(new Node('Child'));
	const animation = child.addComponent(new Animation());
	const skeleton = child.addComponent(new Skeleton());
	const callbacks = child.addComponent(new CallbackComponent());

	const sandbox = {
		module: { exports: {} },
		exports: {},
		console,
		Editor: {
			require() {
				return {
					curMode() {
						return { name: 'prefab' };
					},
				};
			},
		},
		cc: {
			Color,
			Component,
			Animation,
			AudioClip,
			WrapMode: { Loop: 'loop', Normal: 'normal' },
			loader: {
				loadRes(url, type, callback) {
					callback(null, { url, type, duration: 4.5 });
				},
			},
			director: {
				getScene() {
					return { children: [root] };
				},
			},
		},
		sp: {
			Skeleton,
		},
	};
	Vm.createContext(sandbox);
	Vm.runInContext(code, sandbox);

	function call(name, payload) {
		let response;
		sandbox.module.exports[name]({
			reply(err, data) {
				if (err) throw err;
				response = data;
			},
		}, payload);
		return response;
	}

	let res = call('preview-timeline', {
		time: 0.5,
		playing: false,
		timelineData: {
			tracks: [
				{ type: 'tween', targetPath: 'Child', clips: [{ type: 'tween', start: 0, duration: 1, actions: [{ type: 'to', duration: 1, props: { x: 100, opacity: 55, rotation: 90 } }] }] },
				{ type: 'active', targetPath: 'Child', clips: [{ type: 'active', start: 0, duration: 0.25, active: false }] },
			],
		},
	});
	assert(res.ok, 'scene preview failed');
	assert(child.x === 50, 'tween x expected 50');
	assert(child.opacity === 155, 'tween opacity expected 155');
	assert(child.angle === -45, 'tween rotation should map to negative angle');
	assert(child.active === true, 'active should restore outside clip');

	res = call('preview-timeline', {
		time: 0.1,
		playing: false,
		timelineData: {
			tracks: [
				{ type: 'active', targetPath: 'Child', clips: [{ type: 'active', start: 0, duration: 0.25, active: false }] },
			],
		},
	});
	assert(res.ok && child.active === false, 'active clip did not apply');

	call('stop-preview', {});
	assert(child.x === 0 && child.opacity === 255 && child.angle === 0 && child.active === true, 'preview restore failed');

	res = call('preview-timeline', {
		time: 0.1,
		playing: false,
		timelineData: {
			tracks: [
				{ type: 'tween', targetPath: 'Child', clips: [{ type: 'tween', start: 0, duration: 1, actions: [{ type: 'set', props: { active: false } }] }] },
			],
		},
	});
	assert(res.ok && child.active === false, 'tween active prop did not apply');
	call('stop-preview', {});
	assert(child.active === true, 'tween active preview restore failed');

	res = call('preview-timeline', {
		time: 1.5,
		playing: false,
		timelineData: {
			tracks: [
				{
					type: 'tween',
					targetPath: 'Child',
					clips: [{
						type: 'tween',
						start: 0,
						duration: 2,
						actions: [
							{ type: 'to', duration: 1, props: { x: 100 } },
							{ type: 'by', duration: 1, props: { y: 50 } },
						],
					}],
				},
			],
		},
	});
	assert(res.ok && child.x === 100 && child.y === 25, 'tween sequence/to/by sampling failed');
	call('stop-preview', {});

	res = call('preview-timeline', {
		time: 0.5,
		playing: false,
		timelineData: {
			tracks: [
				{
					type: 'tween',
					targetPath: 'Child',
					clips: [{
						type: 'tween',
						start: 0,
						duration: 1,
						actions: [
							{
								type: 'parallel',
								actions: [
									{ type: 'to', duration: 1, props: { x: 100 } },
									{ type: 'to', duration: 1, props: { y: 200 } },
								],
							},
						],
					}],
				},
			],
		},
	});
	assert(res.ok && child.x === 50 && child.y === 100, 'tween parallel sampling failed');
	call('stop-preview', {});

	res = call('preview-timeline', {
		time: 2.5,
		playing: false,
		timelineData: {
			tracks: [
				{
					type: 'tween',
					targetPath: 'Child',
					clips: [{
						type: 'tween',
						start: 0,
						duration: 3,
						actions: [
							{ type: 'repeat', times: 3, actions: [{ type: 'by', duration: 1, props: { x: 10 } }] },
						],
					}],
				},
			],
		},
	});
	assert(res.ok && child.x === 25, 'tween repeat/by sampling failed');
	call('stop-preview', {});

	res = call('preview-timeline', {
		time: 0.25,
		playing: false,
		timelineData: {
			tracks: [
				{
					type: 'tween',
					targetPath: 'Child',
					clips: [{
						type: 'tween',
						start: 0,
						duration: 1,
						actions: [
							{ type: 'reverseTime', actions: [{ type: 'to', duration: 1, props: { x: 100 } }] },
						],
					}],
				},
			],
		},
	});
	assert(res.ok && child.x === 75, 'tween reverseTime sampling failed');
	call('stop-preview', {});

	res = call('preview-timeline', {
		time: 0.5,
		playing: false,
		timelineData: {
			tracks: [
				{
					type: 'tween',
					targetPath: 'Child',
					clips: [{
						type: 'tween',
						start: 0,
						duration: 1,
						actions: [
							{ type: 'bezierTo', duration: 1, c1: { x: 0, y: 100 }, c2: { x: 100, y: 100 }, to: { x: 100, y: 0 } },
						],
					}],
				},
			],
		},
	});
	assert(res.ok && Math.abs(child.x - 50) < 0.000001 && Math.abs(child.y - 75) < 0.000001, 'tween bezierTo sampling failed');
	call('stop-preview', {});

	res = call('preview-timeline', {
		time: 0,
		playing: false,
		timelineData: {
			tracks: [
				{
					type: 'tween',
					targetPath: 'Child',
					clips: [{
						type: 'tween',
						start: 0,
						duration: 0.1,
						actions: [{ type: 'removeSelf' }],
					}],
				},
			],
		},
	});
	assert(res.ok && child.active === false, 'tween removeSelf should deactivate target in preview');
	call('stop-preview', {});
	assert(child.active === true, 'tween removeSelf preview restore failed');

	res = call('preview-timeline', {
		time: 0.1,
		playing: false,
		timelineData: {
			tracks: [
				{
					type: 'tween',
					targetPath: 'Child',
					clips: [{
						type: 'tween',
						start: 0,
						duration: 0.1,
						actions: [{ type: 'call', callbackName: 'onTweenCall', params: ['seek'] }],
					}],
				},
			],
		},
	});
	assert(res.ok && callbacks.calls.length === 0, 'tween call should not trigger while scrubbing');
	res = call('preview-timeline', {
		time: 0.1,
		playing: true,
		timelineData: {
			tracks: [
				{
					type: 'tween',
					targetPath: 'Child',
					clips: [{
						type: 'tween',
						start: 0,
						duration: 0.1,
						actions: [{ type: 'call', callbackName: 'onTweenCall', params: ['play'] }],
					}],
				},
			],
		},
	});
	assert(res.ok && callbacks.calls.length === 1 && callbacks.calls[0][0] === 'play', 'tween call did not trigger during playback');
	res = call('preview-timeline', {
		time: 0.1,
		playing: true,
		timelineData: {
			tracks: [
				{
					type: 'tween',
					targetPath: 'Child',
					clips: [{
						type: 'tween',
						start: 0,
						duration: 0.1,
						actions: [{ type: 'call', callbackName: 'onTweenCall', params: ['play'] }],
					}],
				},
			],
		},
	});
	assert(res.ok && callbacks.calls.length === 1, 'tween call should only trigger once per playback pass');
	call('stop-preview', {});

	res = call('preview-timeline', {
		time: 0.5,
		playing: false,
		timelineData: {
			tracks: [
				{
					type: 'animation',
					targetPath: 'Child',
					clips: [
						{ type: 'animation', start: 0.25, duration: 1, clipName: 'run', speed: 2 },
						{ type: 'spine', start: 0.25, duration: 1, animName: 'walk', speed: 2, trackIndex: 1 },
					],
				},
			],
		},
	});
	assert(res.ok, 'animation/spine preview failed');
	assert(animation.currentTimes.run === 0.5, 'animation clip should sample local time with speed');
	assert(animation.sampled.indexOf('run') >= 0, 'animation sample not called');
	assert(animation.states.run.wrapMode === 'normal', 'animation wrap mode should reset to normal');
	assert(skeleton.entry && skeleton.entry.name === 'walk', 'spine setAnimation not called');
	assert(skeleton.entry.trackIndex === 1, 'spine track index not applied');
	assert(skeleton.entry.trackTime === 0.5, 'spine clip should sample local time with speed');
	assert(skeleton._state.applied > 0, 'spine state not applied');

	res = call('query-clip-durations', {
		timelineData: {
			tracks: [
				{
					type: 'animation',
					targetPath: 'Child',
					clips: [
						{ type: 'animation', clipName: 'run' },
						{ type: 'spine', animName: 'walk' },
						{ type: 'audio', audioUrl: 'audio/sound.mp3' },
					],
				},
			],
		},
	});
	assert(res.ok, 'query clip durations failed');
	const durations = res.clips.map((clip) => clip.duration).sort();
	assert(durations.join(',') === '2,3,4.5', 'resource clip durations did not resolve');
}

function verifyPrefabBinding() {
	const source = read('panel/index.js');
	const start = source.indexOf('function isTimelineComponentType');
	const end = source.indexOf('function assetUrlExists');
	assert(start >= 0 && end > start, 'prefab binding helper slice not found');

	const sandbox = {
		exports: {},
		console,
		TIMELINE_COMPONENT_SCRIPT_UUID: 'legacy-type',
	};
	Vm.createContext(sandbox);
	Vm.runInContext(`
const TIMELINE_COMPONENT_SCRIPT_UUID = 'legacy-type';
${source.slice(start, end)}
exports.bindTimelineComponentToPrefabData = bindTimelineComponentToPrefabData;
`, sandbox);

	const bindTimelineComponentToPrefabData = sandbox.exports.bindTimelineComponentToPrefabData;
	const prefabData = [
		{ __type__: 'cc.Prefab', data: { __id__: 1 } },
		{ __type__: 'cc.Node', _name: 'Root', _components: [], _children: [] },
	];

	let result = bindTimelineComponentToPrefabData(prefabData, {
		componentTypeId: 'compressed-timeline-component',
		typeIds: ['compressed-timeline-component'],
		timelineAssetUuid: 'timeline-json-uuid',
		timelineData: { autoPlay: true, loopMode: 'loop' },
	});
	assert(result.created === true, 'expected component to be created');
	assert(prefabData[1]._components[0].__id__ === 2, 'root component ref missing');
	assert(prefabData[2].__type__ === 'compressed-timeline-component', 'component type mismatch');
	assert(prefabData[2].timelineAsset.__uuid__ === 'timeline-json-uuid', 'timeline asset binding missing');
	assert(prefabData[2].autoPlay === true, 'autoPlay not copied');
	assert(prefabData[2].loopMode === 1, 'loop mode not copied');

	result = bindTimelineComponentToPrefabData(prefabData, {
		componentTypeId: 'compressed-timeline-component',
		typeIds: ['compressed-timeline-component'],
		timelineAssetUuid: 'new-json-uuid',
		timelineData: { autoPlay: false, loopMode: 'pingpong' },
	});
	assert(result.created === false, 'expected component to be updated');
	assert(prefabData[1]._components.length === 1, 'component duplicated');
	assert(prefabData[2].timelineAsset.__uuid__ === 'new-json-uuid', 'timeline asset not updated');
	assert(prefabData[2].autoPlay === false, 'autoPlay not updated');
	assert(prefabData[2].loopMode === 2, 'pingpong mode not updated');
}

function verifyRuntimeTemplates() {
	const required = [
		'templates/runtime/TimelinePlayer.ts',
		'templates/runtime/TimelineComponent.ts',
	];
	required.forEach((file) => {
		const content = read(file);
		assert(content.indexOf('UI Timeline Runtime') !== -1, file + ' missing marker');
		assert(content.indexOf('export default class') !== -1, file + ' missing default export');
		assert(content.indexOf('node.rotation') === -1, file + ' uses deprecated node.rotation');
	});
	const player = read('templates/runtime/TimelinePlayer.ts');
	assert(player.indexOf('private sampleAnimation') !== -1, 'runtime animation sampling missing');
	assert(player.indexOf('private sampleSpine') !== -1, 'runtime spine sampling missing');
	assert(player.indexOf('prop === "active"') !== -1, 'runtime tween active support missing');
	assert(player.indexOf('getTweenActionDuration') !== -1, 'runtime tween action duration support missing');
	assert(player.indexOf('private applyTweenActionList') !== -1, 'runtime tween action sampler missing');
	assert(player.indexOf('private applyTweenCallAction') !== -1, 'runtime tween call support missing');
	assert(player.indexOf('bezierNumber') !== -1 && player.indexOf('private applyTweenBezierAction') !== -1, 'runtime tween bezier support missing');
	assert(player.indexOf('type === "removeSelf"') !== -1, 'runtime tween removeSelf support missing');
	assert(player.indexOf('mode?: string') === -1 && player.indexOf('from?: Record') === -1, 'runtime should not expose legacy tween clip fields');
	assert(player.indexOf('case "animation"') === -1, 'runtime should not trigger animation as one-shot clip');
}

function main() {
	[
		'panel/index.js',
		'main.js',
		'scene-script.js',
	].forEach(checkSyntax);
	verifyPackageJson();
	verifyPanelHelpers();
	verifyKeyboardHelpers();
	verifyScenePreview();
	verifyPrefabBinding();
	verifyRuntimeTemplates();
	console.log('verify ok');
}

main();
