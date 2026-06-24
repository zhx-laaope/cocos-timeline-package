'use strict';

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

module.exports = {
	'query-prefab-context'(event) {
		if (event && event.reply) {
			event.reply(null, getPrefabContext());
		}
	},
};
