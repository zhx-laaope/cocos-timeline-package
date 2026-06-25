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
	const start = source.indexOf('function createDefaultEditorState');
	const end = source.indexOf('function ensureDirectory');
	assert(start >= 0 && end > start, 'panel helper slice not found');

	const sandbox = { exports: {}, console };
	Vm.createContext(sandbox);
	Vm.runInContext(source.slice(start, end) + `
exports.createDefaultClip = createDefaultClip;
exports.normalizeTimelineData = normalizeTimelineData;
exports.getClipType = getClipType;
`, sandbox);

	const { createDefaultClip, normalizeTimelineData, getClipType } = sandbox.exports;
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
	assert(tweenClip.type === 'tween' && tweenClip.start === 1.25 && !!tweenClip.props, 'default tween clip failed');
	assert(getClipType({ type: 'spine' }, {}) === 'spine', 'clip type fallback failed');
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

		clearTracks() {
			this.cleared = true;
		}

		setToSetupPose() {
			this.setup = true;
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

	const root = new Node('Root');
	const child = root.addChild(new Node('Child'));
	const animation = child.addComponent(new Animation());
	const skeleton = child.addComponent(new Skeleton());

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
			WrapMode: { Loop: 'loop', Normal: 'normal' },
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
				{ type: 'tween', targetPath: 'Child', clips: [{ type: 'tween', start: 0, duration: 1, props: { x: 100, opacity: 55, rotation: 90 } }] },
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
