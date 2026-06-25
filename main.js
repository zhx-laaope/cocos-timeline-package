'use strict';

const Fs = require('fs');
const Path = require('path');

const PREFAB_NAME_CACHE = Object.create(null);

function normalizeUuid(uuid) {
	if (!uuid || typeof uuid !== 'string') return '';
	let result = uuid;
	try {
		if (Editor.Utils && Editor.Utils.UuidUtils && Editor.Utils.UuidUtils.decompressUuid) {
			result = Editor.Utils.UuidUtils.decompressUuid(uuid) || uuid;
		}
	} catch (err) {
		result = uuid;
	}
	return result;
}

function uuidToPrefabUrl(uuid) {
	const candidates = [];
	const normalized = normalizeUuid(uuid);
	if (uuid) candidates.push(uuid);
	if (normalized && normalized !== uuid) candidates.push(normalized);

	for (const item of candidates) {
		try {
			const url = Editor.assetdb.uuidToUrl(item);
			if (url && /\.prefab$/i.test(url)) {
				return { uuid: item, url };
			}
		} catch (err) {
			// Try the next candidate.
		}
	}
	return null;
}

function readMetaUuid(fspath) {
	try {
		const meta = JSON.parse(Fs.readFileSync(fspath + '.meta', 'utf8'));
		return meta.uuid || '';
	} catch (err) {
		return '';
	}
}

function fspathToUrl(fspath) {
	try {
		return Editor.assetdb.fspathToUrl(fspath);
	} catch (err) {
		return '';
	}
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

	const url = fspathToUrl(matches[0]);
	if (!url) {
		PREFAB_NAME_CACHE[rootName] = null;
		return null;
	}

	const resolved = {
		uuid: readMetaUuid(matches[0]),
		url,
	};
	PREFAB_NAME_CACHE[rootName] = resolved;
	return resolved;
}

function getSelectedPrefab(rootName) {
	const selection = Editor.Selection && Editor.Selection.curSelection
		? Editor.Selection.curSelection('asset')
		: [];

	for (const uuid of selection || []) {
		const prefab = uuidToPrefabUrl(uuid);
		if (!prefab) continue;

		const name = Path.basename(prefab.url, '.prefab');
		if (!rootName || name === rootName || selection.length === 1) {
			return prefab;
		}
	}
	return null;
}

function resolvePrefabAsset(rawContext) {
	const candidates = rawContext && rawContext.candidateUuids ? rawContext.candidateUuids : [];
	for (const uuid of candidates) {
		if (!uuid || typeof uuid !== 'string') continue;
		const prefab = uuidToPrefabUrl(uuid);
		if (prefab) return prefab;
	}

	return getSelectedPrefab(rawContext.rootName) || findPrefabByRootName(rawContext.rootName);
}

function reply(event, err, data) {
	if (event && event.reply) {
		event.reply(err, data);
	}
}

module.exports = {
	'scene-script': 'scene-script.js',

	load() {
		Editor.log('[UI Timeline Editor] 加载成功');
	},

	unload() {
		Editor.log('[UI Timeline Editor] 卸载');
	},

	open() {
		Editor.Panel.open('ui-timeline-editor');
	},

	queryPrefabContext(event) {
		if (!Editor.Scene || !Editor.Scene.callSceneScript) {
			reply(event, null, {
				inPrefab: false,
				reason: '当前 Creator 不支持查询 prefab 编辑态',
			});
			return;
		}

		Editor.Scene.callSceneScript('ui-timeline-editor', 'query-prefab-context', (err, rawContext) => {
			if (err) {
				reply(event, null, {
					inPrefab: false,
					reason: err.message || err,
				});
				return;
			}

			if (!rawContext || !rawContext.inPrefab) {
				reply(event, null, {
					inPrefab: false,
					modeName: rawContext && rawContext.modeName ? rawContext.modeName : '',
				});
				return;
			}

			const prefab = resolvePrefabAsset(rawContext);
			if (!prefab) {
				reply(event, null, Object.assign({}, rawContext, {
					prefabUuid: '',
					prefabUrl: '',
					reason: '已进入 prefab 编辑态，但未能定位对应 prefab 资源',
				}));
				return;
			}

			reply(event, null, Object.assign({}, rawContext, {
				prefabUuid: prefab.uuid || '',
				prefabUrl: prefab.url,
			}));
		});
	},

	callTimelineSceneScript(event, method, payload) {
		if (!Editor.Scene || !Editor.Scene.callSceneScript) {
			reply(event, null, {
				ok: false,
				warnings: ['当前 Creator 不支持 SceneScript 调用'],
			});
			return;
		}

		Editor.Scene.callSceneScript('ui-timeline-editor', method, payload || {}, (err, result) => {
			if (err) {
				reply(event, null, {
					ok: false,
					warnings: [err.message || String(err)],
				});
				return;
			}
			reply(event, null, result || { ok: true });
		});
	},

	previewTimeline(event, payload) {
		this.callTimelineSceneScript(event, 'preview-timeline', payload);
	},

	stopPreview(event) {
		this.callTimelineSceneScript(event, 'stop-preview', {});
	},

	messages: {
		'open'() {
			this.open();
		},

		'query-prefab-context'(event) {
			this.queryPrefabContext(event);
		},

		'preview-timeline'(event, payload) {
			this.previewTimeline(event, payload);
		},

		'stop-preview'(event) {
			this.stopPreview(event);
		}
	}
};
