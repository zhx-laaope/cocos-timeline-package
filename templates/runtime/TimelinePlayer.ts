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
	clipName?: string;
	animName?: string;
	speed?: number;
	loop?: boolean;
	trackIndex?: number;
	props?: Record<string, any>;
	from?: Record<string, any> | null;
	easing?: string;
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
					this.applyTween(node, clip, this.currentTime - toNumber(clip.start, 0));
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

	private applyTween(node: cc.Node, clip: TimelineClip, localTime: number): void {
		const duration = Math.max(0.0001, toNumber(clip.duration, 0.0001));
		const progress = ease(clip.easing, localTime / duration);
		const props = clip.props || {};
		const from = clip.from || {};
		const snapshot = this.snapshots[node.uuid];

		Object.keys(props).forEach((prop) => {
			const fromValue = Object.prototype.hasOwnProperty.call(from, prop)
				? from[prop]
				: this.getSnapshotProp(snapshot, prop);
			this.applyTweenProp(node, prop, fromValue, props[prop], progress);
		});
	}

	private getSnapshotProp(snapshot: NodeSnapshot | undefined, prop: string): any {
		if (!snapshot) return undefined;
		if (prop === "rotation") return snapshot.rotation;
		if (prop === "angle") return snapshot.angle;
		return (snapshot as any)[prop];
	}

	private applyTweenProp(node: cc.Node, prop: string, fromValue: any, toValue: any, progress: number): void {
		if (prop === "color") {
			const fromColor = parseColor(fromValue || this.getSnapshotProp(this.snapshots[node.uuid], "color"));
			const toColor = parseColor(toValue);
			if (!fromColor || !toColor) return;
			node.color = new cc.Color(
				Math.round(lerp(fromColor.r, toColor.r, progress)),
				Math.round(lerp(fromColor.g, toColor.g, progress)),
				Math.round(lerp(fromColor.b, toColor.b, progress)),
				Math.round(lerp(fromColor.a, toColor.a, progress)),
			);
			return;
		}

		if (prop === "rotation" || prop === "angle") {
			const fallback = prop === "rotation" ? getNodeRotation(node) : getNodeAngle(node);
			const fromNumber = toNumber(fromValue, fallback);
			const toNumberValue = Number(toValue);
			if (!isFinite(toNumberValue)) return;
			const value = lerp(fromNumber, toNumberValue, progress);
			if (prop === "rotation") setNodeRotation(node, value);
			else setNodeAngle(node, value);
			return;
		}

		const fromNumber = toNumber(fromValue, Number((node as any)[prop]) || 0);
		const toNumberValue = Number(toValue);
		if (!isFinite(toNumberValue) || typeof (node as any)[prop] === "undefined") return;
		(node as any)[prop] = lerp(fromNumber, toNumberValue, progress);
	}
}
