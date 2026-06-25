// UI Timeline Runtime

export type TimelineLoopMode = "none" | "loop" | "pingpong";
export type TimelineTrackType = "animation" | "spine" | "tween" | "code" | "audio" | "active";

export interface TimelineClip {
	id?: string;
	type?: TimelineTrackType;
	name?: string;
	start: number;
	duration: number;
	enabled?: boolean;
	actions?: any[] | Record<string, any>;
	clipName?: string;
	animName?: string;
	speed?: number;
	loop?: boolean;
	trackIndex?: number;
	callbackName?: string;
	params?: any[];
	audioUrl?: string;
	volume?: number;
	active?: boolean;
}

export interface TimelineTrack {
	id?: string;
	name?: string;
	type: TimelineTrackType;
	targetPath?: string;
	enabled?: boolean;
	locked?: boolean;
	muted?: boolean;
	clips?: TimelineClip[];
}

export interface TimelineData {
	name?: string;
	version?: string;
	duration: number;
	frameRate?: number;
	loopMode?: TimelineLoopMode;
	autoPlay?: boolean;
	tracks: TimelineTrack[];
}

interface NodeSnapshot {
	active: boolean;
	x: number;
	y: number;
	scaleX: number;
	scaleY: number;
	rotation: number;
	angle: number;
	opacity: number;
	width: number;
	height: number;
	color: cc.Color;
}

interface TimelinePlayerOptions {
	owner?: cc.Component;
	onComplete?: () => void;
}

declare const sp: any;

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function toNumber(value: any, fallback: number): number {
	const result = Number(value);
	return isFinite(result) ? result : fallback;
}

function getNodeRotation(node: cc.Node): number {
	const anyNode = node as any;
	if (typeof anyNode.angle === "number") return -anyNode.angle;
	if (typeof anyNode.rotation === "number") return anyNode.rotation;
	return 0;
}

function setNodeRotation(node: cc.Node, value: number): boolean {
	const number = Number(value);
	if (!isFinite(number)) return false;
	const anyNode = node as any;
	if (typeof anyNode.angle === "number") {
		anyNode.angle = -number;
		return true;
	}
	if (typeof anyNode.rotation !== "undefined") {
		anyNode.rotation = number;
		return true;
	}
	return false;
}

function getNodeAngle(node: cc.Node): number {
	const anyNode = node as any;
	if (typeof anyNode.angle === "number") return anyNode.angle;
	return -getNodeRotation(node);
}

function setNodeAngle(node: cc.Node, value: number): boolean {
	const number = Number(value);
	if (!isFinite(number)) return false;
	const anyNode = node as any;
	if (typeof anyNode.angle === "number") {
		anyNode.angle = number;
		return true;
	}
	return setNodeRotation(node, -number);
}

function cloneColor(color: cc.Color): cc.Color {
	return new cc.Color(color.r, color.g, color.b, color.a);
}

function parseColor(value: any): cc.Color | null {
	if (!value) return null;
	if (value instanceof cc.Color) return value;

	if (typeof value === "string") {
		const match = value.trim().match(/^#?([0-9a-f]{6}|[0-9a-f]{8})$/i);
		if (!match) return null;
		const hex = match[1];
		const r = parseInt(hex.slice(0, 2), 16);
		const g = parseInt(hex.slice(2, 4), 16);
		const b = parseInt(hex.slice(4, 6), 16);
		const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255;
		return new cc.Color(r, g, b, a);
	}

	if (typeof value === "object") {
		return new cc.Color(
			toNumber(value.r, 0),
			toNumber(value.g, 0),
			toNumber(value.b, 0),
			value.a === undefined ? 255 : toNumber(value.a, 255),
		);
	}

	return null;
}

function ease(name: string | undefined, progress: number): number {
	const t = clamp01(progress);
	switch (name) {
		case "sineIn":
			return 1 - Math.cos((t * Math.PI) / 2);
		case "sineOut":
			return Math.sin((t * Math.PI) / 2);
		case "sineInOut":
			return -(Math.cos(Math.PI * t) - 1) / 2;
		case "quadIn":
			return t * t;
		case "quadOut":
			return 1 - (1 - t) * (1 - t);
		case "quadInOut":
			return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
		case "cubicIn":
			return t * t * t;
		case "cubicOut":
			return 1 - Math.pow(1 - t, 3);
		case "cubicInOut":
			return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
		case "backOut": {
			const c1 = 1.70158;
			const c3 = c1 + 1;
			return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
		}
		case "bounceOut": {
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

function lerp(from: number, to: number, progress: number): number {
	return from + (to - from) * progress;
}

function bezierNumber(c1: number, c2: number, c3: number, c4: number, progress: number): number {
	const t = clamp01(progress);
	const t1 = 1 - t;
	return t1 * (t1 * (c1 + (c2 * 3 - c1) * t) + c3 * 3 * t * t) + c4 * t * t * t;
}

function readTweenVec2(value: any, fallback: { x: number; y: number }): { x: number; y: number } {
	const source = value && typeof value === "object" ? value : {};
	return {
		x: toNumber(source.x === undefined ? fallback.x : source.x, 0),
		y: toNumber(source.y === undefined ? fallback.y : source.y, 0),
	};
}

function isTweenActionClip(clip: TimelineClip): boolean {
	return !!(clip && (Array.isArray(clip.actions) || (clip.actions && typeof clip.actions === "object")));
}

function asTweenActionArray(actions: any): any[] {
	if (Array.isArray(actions)) return actions;
	if (actions && typeof actions === "object") return [actions];
	return [];
}

function getTweenActionChildren(action: any): any[] {
	if (!action || typeof action !== "object") return [];
	if (Array.isArray(action.actions)) return action.actions;
	if (Array.isArray(action.sequence)) return action.sequence;
	if (Array.isArray(action.parallel)) return action.parallel;
	if (action.action && typeof action.action === "object") return [action.action];
	return [];
}

function getTweenActionDuration(action: any, fallbackDuration: number): number {
	if (!action || typeof action !== "object") return 0;
	const type = action.type || "to";
	const duration = Math.max(0, toNumber(action.duration, 0));

	if (type === "sequence" || type === "then") {
		return getTweenActionsDuration(getTweenActionChildren(action), fallbackDuration);
	}
	if (type === "parallel" || type === "spawn") {
		return getTweenActionChildren(action).reduce((max: number, child: any) => {
			return Math.max(max, getTweenActionDuration(child, fallbackDuration));
		}, 0);
	}
	if (type === "repeat") {
		return getTweenActionsDuration(getTweenActionChildren(action), fallbackDuration) * Math.max(0, parseInt(action.times, 10) || 0);
	}
	if (type === "repeatForever") {
		return duration || Math.max(0, fallbackDuration || 0);
	}
	if (type === "reverseTime") {
		return getTweenActionsDuration(getTweenActionChildren(action), fallbackDuration);
	}
	if (type === "delay" || type === "to" || type === "by" || type === "blink" || type === "bezierTo" || type === "bezierBy") {
		return duration;
	}
	return 0;
}

function getTweenActionsDuration(actions: any, fallbackDuration: number): number {
	return asTweenActionArray(actions).reduce((total: number, action: any) => {
		return total + getTweenActionDuration(action, fallbackDuration);
	}, 0);
}

function getTweenClipActions(clip: TimelineClip): any[] {
	const actions = isTweenActionClip(clip) ? asTweenActionArray(clip.actions) : [];
	return actions.length > 0 ? actions : [{ type: "delay", duration: toNumber(clip.duration, 0) }];
}

function getClipSampleTime(clip: TimelineClip, localTime: number, duration: number): number {
	let sampleTime = Math.max(0, localTime * toNumber(clip.speed, 1));
	if (clip.loop && duration > 0) {
		sampleTime = sampleTime % duration;
	} else if (duration > 0) {
		sampleTime = Math.min(sampleTime, duration);
	}
	return sampleTime;
}

export default class TimelinePlayer {
	public currentTime = 0;
	public playing = false;

	private root: cc.Node;
	private timeline: TimelineData | null = null;
	private options: TimelinePlayerOptions;
	private direction = 1;
	private lastTime = 0;
	private snapshots: Record<string, NodeSnapshot> = {};
	private triggered: Record<string, boolean> = {};
	private audioIds: number[] = [];

	constructor(root: cc.Node, options: TimelinePlayerOptions = {}) {
		this.root = root;
		this.options = options;
	}

	public load(timeline: TimelineData | null): void {
		this.stop();
		this.timeline = timeline || null;
	}

	public hasTimeline(): boolean {
		return !!this.timeline;
	}

	public play(timeline?: TimelineData, options?: TimelinePlayerOptions): void {
		if (timeline) this.load(timeline);
		if (options) {
			this.options.owner = options.owner || this.options.owner;
			this.options.onComplete = options.onComplete || this.options.onComplete;
		}
		if (!this.timeline) return;

		this.playing = true;
		this.direction = 1;
		this.lastTime = this.currentTime;
		this.triggered = {};
		this.captureAllTrackSnapshots();
		this.sample(this.currentTime, true);
	}

	public pause(): void {
		this.playing = false;
	}

	public resume(): void {
		if (!this.timeline) return;
		this.playing = true;
		this.lastTime = this.currentTime;
	}

	public stop(restore: boolean = true): void {
		this.playing = false;
		this.currentTime = 0;
		this.direction = 1;
		this.lastTime = 0;
		this.triggered = {};
		this.stopAudio();
		if (restore) {
			this.restoreSnapshots();
			this.snapshots = {};
		}
	}

	public update(dt: number, speed: number = 1): void {
		if (!this.playing || !this.timeline) return;

		const duration = Math.max(0.0001, toNumber(this.timeline.duration, 0.0001));
		const loopMode = this.timeline.loopMode || "none";
		this.lastTime = this.currentTime;
		this.currentTime += dt * speed * this.direction;

		if (loopMode === "loop") {
			if (this.currentTime >= duration) {
				this.currentTime = this.currentTime % duration;
				this.lastTime = 0;
				this.triggered = {};
			}
		} else if (loopMode === "pingpong") {
			if (this.currentTime >= duration) {
				this.currentTime = duration - (this.currentTime - duration);
				this.direction = -1;
				this.triggered = {};
			} else if (this.currentTime <= 0) {
				this.currentTime = -this.currentTime;
				this.direction = 1;
				this.triggered = {};
			}
			this.currentTime = Math.max(0, Math.min(duration, this.currentTime));
		} else if (this.currentTime >= duration) {
			this.currentTime = duration;
			this.sample(this.currentTime, true);
			this.playing = false;
			if (this.options.onComplete) this.options.onComplete();
			return;
		}

		this.sample(this.currentTime, true);
	}

	public sample(time: number, playing: boolean = false): void {
		if (!this.timeline) return;

		const duration = Math.max(0.0001, toNumber(this.timeline.duration, 0.0001));
		this.currentTime = Math.max(0, Math.min(duration, time));
		this.captureAllTrackSnapshots();
		this.restoreSnapshotValues();

		for (let trackIndex = 0; trackIndex < this.timeline.tracks.length; trackIndex++) {
			const track = this.timeline.tracks[trackIndex];
			if (!track || track.enabled === false || track.muted) continue;

			const node = this.resolveTarget(track.targetPath || ".");
			if (!node) continue;

			const clips = track.clips || [];
			for (let clipIndex = 0; clipIndex < clips.length; clipIndex++) {
				const clip = clips[clipIndex];
				if (!clip || clip.enabled === false || !this.clipContainsTime(clip, this.currentTime)) continue;

				const type = clip.type || track.type;
				if (type === "active") {
					node.active = clip.active !== false;
					continue;
				}
				if (type === "tween") {
					this.applyTween(
						node,
						clip,
						this.currentTime - toNumber(clip.start, 0),
						playing,
						`${trackIndex}:${clipIndex}:${clip.id || clip.name || "tween"}`,
					);
					continue;
				}

				if (type === "animation") {
					this.sampleAnimation(node, clip, this.currentTime - toNumber(clip.start, 0));
					continue;
				}

				if (type === "spine") {
					this.sampleSpine(node, clip, this.currentTime - toNumber(clip.start, 0));
					continue;
				}

				if (!playing || !this.shouldTrigger(trackIndex, clipIndex, clip)) continue;
				this.triggerClip(node, type, clip);
			}
		}
	}

	private resolveTarget(targetPath: string): cc.Node | null {
		if (!targetPath || targetPath === "." || targetPath === "./") return this.root;

		let current: cc.Node | null = this.root;
		const parts = targetPath.split("/").filter((part) => !!part && part !== ".");
		for (const part of parts) {
			if (!current) return null;
			if (part === "..") {
				current = current.parent;
				continue;
			}
			current = current.getChildByName(part);
		}
		return current;
	}

	private captureAllTrackSnapshots(): void {
		if (!this.timeline) return;
		for (const track of this.timeline.tracks) {
			if (!track || track.enabled === false || track.muted) continue;
			const node = this.resolveTarget(track.targetPath || ".");
			if (node) this.captureSnapshot(node);
		}
	}

	private captureSnapshot(node: cc.Node): void {
		if (!node || this.snapshots[node.uuid]) return;
		this.snapshots[node.uuid] = {
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

	private restoreSnapshots(): void {
		this.restoreSnapshotValues();
	}

	private restoreSnapshotValues(): void {
		Object.keys(this.snapshots).forEach((uuid) => {
			const node = this.findNodeByUuid(this.root, uuid);
			const snapshot = this.snapshots[uuid];
			if (!node || !snapshot || !node.isValid) return;

			node.active = snapshot.active;
			node.x = snapshot.x;
			node.y = snapshot.y;
			node.scaleX = snapshot.scaleX;
			node.scaleY = snapshot.scaleY;
			setNodeRotation(node, snapshot.rotation);
			node.opacity = snapshot.opacity;
			node.width = snapshot.width;
			node.height = snapshot.height;
			node.color = cloneColor(snapshot.color);
			this.resetNodeSampledState(node);
		});
	}

	private findNodeByUuid(node: cc.Node, uuid: string): cc.Node | null {
		if (node.uuid === uuid) return node;
		for (const child of node.children) {
			const found = this.findNodeByUuid(child, uuid);
			if (found) return found;
		}
		return null;
	}

	private clipContainsTime(clip: TimelineClip, time: number): boolean {
		const start = toNumber(clip.start, 0);
		const duration = Math.max(0, toNumber(clip.duration, 0));
		return time >= start && time <= start + duration;
	}

	private shouldTrigger(trackIndex: number, clipIndex: number, clip: TimelineClip): boolean {
		const key = `${trackIndex}:${clipIndex}:${clip.id || clip.name || ""}`;
		if (this.triggered[key]) return false;

		const start = toNumber(clip.start, 0);
		const forward = this.direction >= 0;
		const crossed = forward
			? this.lastTime <= start && this.currentTime >= start
			: this.lastTime >= start && this.currentTime <= start;
		if (!crossed) return false;

		this.triggered[key] = true;
		return true;
	}

	private triggerClip(node: cc.Node, type: TimelineTrackType, clip: TimelineClip): void {
		switch (type) {
			case "code":
				this.triggerCode(node, clip);
				break;
			case "audio":
				this.triggerAudio(clip);
				break;
		}
	}

	private resetNodeSampledState(node: cc.Node): void {
		const animation = node.getComponent(cc.Animation);
		if (animation) animation.stop();

		if (typeof sp === "undefined" || !sp.Skeleton) return;
		const skeleton = node.getComponent(sp.Skeleton);
		if (!skeleton) return;
		if (skeleton.clearTracks) skeleton.clearTracks();
		if (skeleton.setToSetupPose) skeleton.setToSetupPose();
	}

	private sampleAnimation(node: cc.Node, clip: TimelineClip, localTime: number): void {
		const animation = node.getComponent(cc.Animation);
		if (!animation || !clip.clipName) return;
		let state = animation.getAnimationState ? animation.getAnimationState(clip.clipName) : null;
		if (!state) state = animation.play(clip.clipName, 0);
		if (!state) return;
		state.speed = toNumber(clip.speed, 1);
		if (cc.WrapMode) state.wrapMode = clip.loop ? cc.WrapMode.Loop : cc.WrapMode.Normal;
		const duration = toNumber(state.duration || (state.clip && state.clip.duration), 0);
		const sampleTime = getClipSampleTime(clip, localTime, duration);
		animation.setCurrentTime(sampleTime, clip.clipName);
		animation.sample(clip.clipName);
	}

	private sampleSpine(node: cc.Node, clip: TimelineClip, localTime: number): void {
		if (typeof sp === "undefined" || !sp.Skeleton || !clip.animName) return;
		const skeleton = node.getComponent(sp.Skeleton);
		if (!skeleton) return;
		skeleton.timeScale = 1;
		const entry = skeleton.setAnimation(Math.max(0, parseInt(String(clip.trackIndex || 0), 10) || 0), clip.animName, !!clip.loop);
		if (!entry) return;
		const duration = toNumber(entry.animationEnd || (entry.animation && entry.animation.duration), 0);
		entry.trackTime = getClipSampleTime(clip, localTime, duration);
		if (entry.animationLast !== undefined) entry.animationLast = entry.trackTime;
		const state = skeleton.getState && skeleton.getState();
		const rawSkeleton = (skeleton as any)._skeleton;
		if (state && rawSkeleton) {
			state.update(0);
			state.apply(rawSkeleton);
			rawSkeleton.updateWorldTransform();
		} else if (skeleton.update) {
			skeleton.update(0);
		} else if (skeleton.updateWorldTransform) {
			skeleton.updateWorldTransform();
		}
	}

	private triggerCode(node: cc.Node, clip: TimelineClip): void {
		if (!clip.callbackName) return;
		const params = Array.isArray(clip.params) ? clip.params : [];
		const candidates: cc.Component[] = [];
		if (this.options.owner) candidates.push(this.options.owner);
		candidates.push(...node.getComponents(cc.Component));
		candidates.push(...this.root.getComponents(cc.Component));

		for (const component of candidates) {
			const fn = (component as any)[clip.callbackName];
			if (typeof fn === "function") {
				fn.apply(component, params);
				return;
			}
		}
	}

	private triggerAudio(clip: TimelineClip): void {
		if (!clip.audioUrl) return;
		cc.loader.loadRes(clip.audioUrl, cc.AudioClip, (err: Error | null, audio: cc.AudioClip) => {
			if (err || !audio) return;
			const id = cc.audioEngine.play(audio, !!clip.loop, clamp01(toNumber(clip.volume, 1)));
			this.audioIds.push(id);
		});
	}

	private stopAudio(): void {
		for (const id of this.audioIds) {
			cc.audioEngine.stop(id);
		}
		this.audioIds.length = 0;
	}

	private applyTween(node: cc.Node, clip: TimelineClip, localTime: number, playing: boolean = false, keyPrefix: string = "tween"): void {
		this.applyTweenActionList(node, getTweenClipActions(clip), localTime, toNumber(clip.duration, 0), playing, keyPrefix, "root");
	}

	private cloneTweenValue(value: any): any {
		if (value instanceof cc.Color) return new cc.Color(value.r, value.g, value.b, value.a);
		if (value && typeof value === "object") {
			if (value.r !== undefined && value.g !== undefined && value.b !== undefined) {
				return { r: value.r, g: value.g, b: value.b, a: value.a };
			}
			if (value.x !== undefined || value.y !== undefined || value.z !== undefined) {
				return {
					x: toNumber(value.x, 0),
					y: toNumber(value.y, 0),
					z: toNumber(value.z, 0),
				};
			}
		}
		return value;
	}

	private getTweenPropValue(node: cc.Node, prop: string): any {
		const anyNode = node as any;
		if (prop === "active") return node.active;
		if (prop === "rotation") return getNodeRotation(node);
		if (prop === "angle") return getNodeAngle(node);
		if (prop === "position") {
			return { x: toNumber(anyNode.x, 0), y: toNumber(anyNode.y, 0), z: toNumber(anyNode.z, 0) };
		}
		if (prop === "scale") {
			if (typeof anyNode.scale !== "undefined") return anyNode.scale;
			return { x: toNumber(anyNode.scaleX, 0), y: toNumber(anyNode.scaleY, 0) };
		}
		if (prop === "color") return cloneColor(node.color);
		return this.cloneTweenValue(anyNode[prop]);
	}

	private setTweenPropValue(node: cc.Node, prop: string, value: any): boolean {
		const anyNode = node as any;
		if (prop === "active") {
			node.active = !!value;
			return true;
		}
		if (prop === "rotation") return setNodeRotation(node, value);
		if (prop === "angle") return setNodeAngle(node, value);
		if (prop === "position") {
			if (!value || typeof value !== "object") return false;
			if (value.x !== undefined) anyNode.x = toNumber(value.x, 0);
			if (value.y !== undefined) anyNode.y = toNumber(value.y, 0);
			if (value.z !== undefined && typeof anyNode.z !== "undefined") anyNode.z = toNumber(value.z, 0);
			return true;
		}
		if (prop === "scale") {
			if (typeof value === "number") {
				if (typeof anyNode.scale !== "undefined") anyNode.scale = value;
				if (typeof anyNode.scaleX !== "undefined") anyNode.scaleX = value;
				if (typeof anyNode.scaleY !== "undefined") anyNode.scaleY = value;
				return true;
			}
			if (value && typeof value === "object") {
				if (value.x !== undefined && typeof anyNode.scaleX !== "undefined") anyNode.scaleX = toNumber(value.x, 0);
				if (value.y !== undefined && typeof anyNode.scaleY !== "undefined") anyNode.scaleY = toNumber(value.y, 0);
				return true;
			}
			return false;
		}
		if (prop === "color") {
			const color = parseColor(value);
			if (!color) return false;
			node.color = color;
			return true;
		}
		if (typeof anyNode[prop] === "undefined") return false;
		anyNode[prop] = value;
		return true;
	}

	private addTweenValues(fromValue: any, deltaValue: any): any {
		const fromNumber = Number(fromValue);
		const deltaNumber = Number(deltaValue);
		if (isFinite(fromNumber) && isFinite(deltaNumber)) return fromNumber + deltaNumber;

		const fromColor = parseColor(fromValue);
		const deltaColor = parseColor(deltaValue);
		if (fromColor && deltaColor) {
			return new cc.Color(
				fromColor.r + deltaColor.r,
				fromColor.g + deltaColor.g,
				fromColor.b + deltaColor.b,
				fromColor.a + deltaColor.a,
			);
		}

		if (fromValue && deltaValue && typeof fromValue === "object" && typeof deltaValue === "object") {
			return {
				x: toNumber(fromValue.x, 0) + toNumber(deltaValue.x, 0),
				y: toNumber(fromValue.y, 0) + toNumber(deltaValue.y, 0),
				z: toNumber(fromValue.z, 0) + toNumber(deltaValue.z, 0),
			};
		}

		return deltaValue;
	}

	private interpolateTweenValue(fromValue: any, toValue: any, progress: number): any {
		if (typeof toValue === "boolean") return toValue;

		const fromColor = parseColor(fromValue);
		const toColor = parseColor(toValue);
		if (fromColor && toColor) {
			return new cc.Color(
				Math.round(lerp(fromColor.r, toColor.r, progress)),
				Math.round(lerp(fromColor.g, toColor.g, progress)),
				Math.round(lerp(fromColor.b, toColor.b, progress)),
				Math.round(lerp(fromColor.a, toColor.a, progress)),
			);
		}

		const fromNumber = Number(fromValue);
		const toNumberValue = Number(toValue);
		if (isFinite(fromNumber) && isFinite(toNumberValue)) return lerp(fromNumber, toNumberValue, progress);

		if (fromValue && toValue && typeof fromValue === "object" && typeof toValue === "object") {
			return {
				x: lerp(toNumber(fromValue.x, 0), toNumber(toValue.x, 0), progress),
				y: lerp(toNumber(fromValue.y, 0), toNumber(toValue.y, 0), progress),
				z: lerp(toNumber(fromValue.z, 0), toNumber(toValue.z, 0), progress),
			};
		}

		return progress >= 1 ? toValue : fromValue;
	}

	private getTweenPropSpec(rawValue: any): { value: any; easing?: string } {
		if (rawValue && typeof rawValue === "object" && rawValue.value !== undefined && (rawValue.easing || rawValue.progress)) {
			return {
				value: rawValue.value,
				easing: rawValue.easing,
			};
		}
		return { value: rawValue };
	}

	private collectTweenActionProps(action: any, props: Record<string, boolean>): Record<string, boolean> {
		if (!action || typeof action !== "object") return props;
		const type = action.type || "to";
		if (type === "to" || type === "by" || type === "set") {
			Object.keys(action.props || {}).forEach((prop) => {
				props[prop] = true;
			});
		}
		if (type === "show" || type === "hide" || type === "removeSelf") props.active = true;
		if (type === "flipX") props.scaleX = true;
		if (type === "flipY") props.scaleY = true;
		if (type === "blink") props.opacity = true;
		if (type === "bezierTo" || type === "bezierBy") props.position = true;
		getTweenActionChildren(action).forEach((child) => this.collectTweenActionProps(child, props));
		return props;
	}

	private captureTweenProps(node: cc.Node, props: Record<string, boolean>): Record<string, any> {
		const snapshot: Record<string, any> = {};
		Object.keys(props).forEach((prop) => {
			snapshot[prop] = this.cloneTweenValue(this.getTweenPropValue(node, prop));
		});
		return snapshot;
	}

	private applyTweenProps(node: cc.Node, values: Record<string, any>): void {
		Object.keys(values).forEach((prop) => {
			this.setTweenPropValue(node, prop, this.cloneTweenValue(values[prop]));
		});
	}

	private applyTweenPropertyAction(node: cc.Node, action: any, localTime: number): void {
		const type = action.type || "to";
		const props = action.props && typeof action.props === "object" ? action.props : {};
		const from = action.from && typeof action.from === "object" ? action.from : {};
		const duration = Math.max(0.0001, toNumber(action.duration, 0.0001));
		const normalized = clamp01(localTime / duration);

		Object.keys(props).forEach((prop) => {
			const spec = this.getTweenPropSpec(props[prop]);
			const fromValue = Object.prototype.hasOwnProperty.call(from, prop)
				? from[prop]
				: this.getTweenPropValue(node, prop);
			const endValue = type === "by" ? this.addTweenValues(fromValue, spec.value) : spec.value;
			const progress = ease(spec.easing || action.easing, normalized);
			this.setTweenPropValue(node, prop, this.interpolateTweenValue(fromValue, endValue, progress));
		});
	}

	private applyTweenBezierAction(node: cc.Node, action: any, localTime: number): void {
		const type = action.type || "bezierTo";
		const duration = Math.max(0.0001, toNumber(action.duration, 0.0001));
		const progress = ease(action.easing, clamp01(localTime / duration));
		const start = this.getTweenPropValue(node, "position");
		const c1 = readTweenVec2(action.c1 || action.control1, { x: 0, y: 100 });
		const c2 = readTweenVec2(action.c2 || action.control2, { x: 100, y: 100 });
		const end = readTweenVec2(action.to || action.end || action.position, { x: 100, y: 0 });
		const control1 = type === "bezierBy" ? this.addTweenValues(start, c1) : c1;
		const control2 = type === "bezierBy" ? this.addTweenValues(start, c2) : c2;
		const target = type === "bezierBy" ? this.addTweenValues(start, end) : end;
		this.setTweenPropValue(node, "position", {
			x: bezierNumber(start.x, control1.x, control2.x, target.x, progress),
			y: bezierNumber(start.y, control1.y, control2.y, target.y, progress),
		});
	}

	private applyTweenInstantAction(node: cc.Node, action: any, localTime: number): void {
		if (localTime < 0) return;
		const type = action.type || "set";
		if (type === "set") {
			const props = action.props && typeof action.props === "object" ? action.props : {};
			Object.keys(props).forEach((prop) => this.setTweenPropValue(node, prop, props[prop]));
			return;
		}
		if (type === "show") {
			node.active = true;
			return;
		}
		if (type === "hide") {
			node.active = false;
			return;
		}
		if (type === "removeSelf") {
			node.active = false;
			return;
		}
		if (type === "flipX") {
			(node as any).scaleX *= -1;
			return;
		}
		if (type === "flipY") {
			(node as any).scaleY *= -1;
		}
	}

	private applyTweenCallAction(node: cc.Node, action: any, playing: boolean, key: string): void {
		if (!playing || this.triggered[key]) return;
		this.triggered[key] = true;
		this.triggerCode(node, {
			callbackName: action.callbackName || action.name,
			params: Array.isArray(action.params) ? action.params : [],
			start: 0,
			duration: 0,
		});
	}

	private applyTweenParallelAction(node: cc.Node, action: any, localTime: number, fallbackDuration: number, playing: boolean, keyPrefix: string, path: string): void {
		const children = getTweenActionChildren(action);
		if (children.length === 0) return;
		const propSet: Record<string, boolean> = {};
		children.forEach((child) => this.collectTweenActionProps(child, propSet));
		const baseline = this.captureTweenProps(node, propSet);
		const merged: Record<string, any> = Object.assign({}, baseline);

		children.forEach((child, index) => {
			this.applyTweenProps(node, baseline);
			this.applyTweenAction(node, child, Math.min(localTime, getTweenActionDuration(child, fallbackDuration)), fallbackDuration, playing, keyPrefix, `${path}.p${index}`);
			const childProps = this.collectTweenActionProps(child, {});
			Object.keys(childProps).forEach((prop) => {
				merged[prop] = this.cloneTweenValue(this.getTweenPropValue(node, prop));
			});
		});

		this.applyTweenProps(node, merged);
	}

	private applyTweenRepeatAction(node: cc.Node, action: any, localTime: number, fallbackDuration: number, playing: boolean, keyPrefix: string, path: string): void {
		const children = getTweenActionChildren(action);
		const childDuration = getTweenActionsDuration(children, fallbackDuration);
		const times = Math.max(0, parseInt(action.times, 10) || 0);
		if (children.length === 0 || times <= 0) return;
		if (childDuration <= 0) {
			this.applyTweenActionList(node, children, 0, fallbackDuration, playing, keyPrefix, `${path}.r0`);
			return;
		}
		const completed = Math.min(times, Math.floor(Math.max(0, localTime) / childDuration));
		for (let i = 0; i < completed; i++) {
			this.applyTweenActionList(node, children, childDuration, fallbackDuration, playing, keyPrefix, `${path}.r${i}`);
		}
		if (completed < times) {
			this.applyTweenActionList(node, children, Math.max(0, localTime - completed * childDuration), fallbackDuration, playing, keyPrefix, `${path}.r${completed}`);
		}
	}

	private applyTweenRepeatForeverAction(node: cc.Node, action: any, localTime: number, fallbackDuration: number, playing: boolean, keyPrefix: string, path: string): void {
		const children = getTweenActionChildren(action);
		const childDuration = getTweenActionsDuration(children, fallbackDuration);
		if (children.length === 0) return;
		if (childDuration <= 0) {
			this.applyTweenActionList(node, children, 0, fallbackDuration, playing, keyPrefix, `${path}.rf0`);
			return;
		}
		const loops = Math.min(10000, Math.floor(Math.max(0, localTime) / childDuration));
		for (let i = 0; i < loops; i++) {
			this.applyTweenActionList(node, children, childDuration, fallbackDuration, playing, keyPrefix, `${path}.rf${i}`);
		}
		this.applyTweenActionList(node, children, Math.max(0, localTime - loops * childDuration), fallbackDuration, playing, keyPrefix, `${path}.rf${loops}`);
	}

	private applyTweenAction(node: cc.Node, action: any, localTime: number, fallbackDuration: number, playing: boolean, keyPrefix: string, path: string): void {
		if (!action || typeof action !== "object") return;
		const type = action.type || "to";
		const duration = getTweenActionDuration(action, fallbackDuration);
		const clampedTime = Math.max(0, Math.min(localTime, duration || 0));

		if (type === "delay") return;
		if (type === "call") {
			if (localTime >= 0) this.applyTweenCallAction(node, action, playing, `${keyPrefix}:call:${path || "call"}`);
			return;
		}
		if (type === "to" || type === "by") {
			this.applyTweenPropertyAction(node, action, clampedTime);
			return;
		}
		if (type === "bezierTo" || type === "bezierBy") {
			this.applyTweenBezierAction(node, action, clampedTime);
			return;
		}
		if (type === "set" || type === "show" || type === "hide" || type === "flipX" || type === "flipY" || type === "removeSelf") {
			this.applyTweenInstantAction(node, action, localTime);
			return;
		}
		if (type === "blink") {
			const times = Math.max(1, parseInt(action.times, 10) || 1);
			const slice = 1 / times;
			const t = duration > 0 ? clamp01(clampedTime / duration) : 1;
			(node as any).opacity = t >= 1 ? this.getTweenPropValue(node, "opacity") : ((t % slice) > slice / 2 ? 255 : 0);
			return;
		}
		if (type === "sequence" || type === "then") {
			this.applyTweenActionList(node, getTweenActionChildren(action), clampedTime, fallbackDuration, playing, keyPrefix, path);
			return;
		}
		if (type === "parallel" || type === "spawn") {
			this.applyTweenParallelAction(node, action, clampedTime, fallbackDuration, playing, keyPrefix, path || "parallel");
			return;
		}
		if (type === "repeat") {
			this.applyTweenRepeatAction(node, action, clampedTime, fallbackDuration, playing, keyPrefix, path || "repeat");
			return;
		}
		if (type === "repeatForever") {
			this.applyTweenRepeatForeverAction(node, action, clampedTime, fallbackDuration, playing, keyPrefix, path || "repeatForever");
			return;
		}
		if (type === "reverseTime") {
			const children = getTweenActionChildren(action);
			const childDuration = getTweenActionsDuration(children, fallbackDuration);
			this.applyTweenActionList(node, children, Math.max(0, childDuration - clampedTime), fallbackDuration, playing, keyPrefix, path || "reverseTime");
		}
	}

	private applyTweenActionList(node: cc.Node, actions: any, localTime: number, fallbackDuration: number, playing: boolean, keyPrefix: string, pathPrefix: string): void {
		let cursor = Math.max(0, localTime);
		asTweenActionArray(actions).forEach((action, index) => {
			const duration = getTweenActionDuration(action, fallbackDuration);
			const path = `${pathPrefix || "a"}.${index}`;
			if (duration <= 0) {
				if (cursor >= 0) this.applyTweenAction(node, action, 0, fallbackDuration, playing, keyPrefix, path);
				return;
			}
			if (cursor >= duration) {
				this.applyTweenAction(node, action, duration, fallbackDuration, playing, keyPrefix, path);
				cursor -= duration;
				return;
			}
			if (cursor >= 0) {
				this.applyTweenAction(node, action, cursor, fallbackDuration, playing, keyPrefix, path);
				cursor = -1;
			}
		});
	}
}
