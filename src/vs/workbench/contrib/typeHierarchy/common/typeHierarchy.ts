/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IRange, Range } from 'vs/editor/common/core/range';
import { SymbolKind, ProviderResult, SymbolTag } from 'vs/editor/common/modes';
import { ITextModel } from 'vs/editor/common/model';
import { CancellationToken } from 'vs/base/common/cancellation';
import { LanguageFeatureRegistry } from 'vs/editor/common/modes/languageFeatureRegistry';
import { URI } from 'vs/base/common/uri';
import { IPosition, Position } from 'vs/editor/common/core/position';
import { isNonEmptyArray } from 'vs/base/common/arrays';
import { onUnexpectedExternalError } from 'vs/base/common/errors';
import { IDisposable, RefCountedDisposable } from 'vs/base/common/lifecycle';
import { CommandsRegistry } from 'vs/platform/commands/common/commands';
import { assertType } from 'vs/base/common/types';
import { IModelService } from 'vs/editor/common/services/modelService';
import { ITextModelService } from 'vs/editor/common/services/resolverService';



export interface TypeHierarchyItem {
	_sessionId: string;
	_itemId: string;
	name: string;
	kind: SymbolKind;
	detail?: string;
	uri: URI;
	range: IRange;
	selectionRange: IRange;
	tags?: SymbolTag[]
}

export interface TypeHierarchySession {
	roots: TypeHierarchyItem[];
	dispose(): void;
}

export interface TypeHierarchyProvider {
	prepareTypeHierarchy(document: ITextModel, position: IPosition, token: CancellationToken): ProviderResult<TypeHierarchySession>;
	provideSupertypes(item: TypeHierarchyItem, token: CancellationToken): ProviderResult<TypeHierarchyItem[]>;
	provideSubtypes(item: TypeHierarchyItem, token: CancellationToken): ProviderResult<TypeHierarchyItem[]>;
}

export const TypeHierarchyProviderRegistry = new LanguageFeatureRegistry<TypeHierarchyProvider>();



export class TypeHierarchyModel {

	static async create(model: ITextModel, position: IPosition, token: CancellationToken): Promise<TypeHierarchyModel | undefined> {
		const [provider] = TypeHierarchyProviderRegistry.ordered(model);
		if (!provider) {
			return undefined;
		}
		const session = await provider.prepareTypeHierarchy(model, position, token);
		if (!session) {
			return undefined;
		}
		return new TypeHierarchyModel(session.roots.reduce((p, c) => p + c._sessionId, ''), provider, session.roots, new RefCountedDisposable(session));
	}

	readonly root: TypeHierarchyItem;

	private constructor(
		readonly id: string,
		readonly provider: TypeHierarchyProvider,
		readonly roots: TypeHierarchyItem[],
		readonly ref: RefCountedDisposable,
	) {
		this.root = roots[0];
	}

	dispose(): void {
		this.ref.release();
	}

	fork(item: TypeHierarchyItem): TypeHierarchyModel {
		const that = this;
		return new class extends TypeHierarchyModel {
			constructor() {
				super(that.id, that.provider, [item], that.ref.acquire());
			}
		};
	}

	async provideSupertypes(item: TypeHierarchyItem, token: CancellationToken): Promise<TypeHierarchyItem[]> {
		try {
			const result = await this.provider.provideSupertypes(item, token);
			if (isNonEmptyArray(result)) {
				return result;
			}
		} catch (e) {
			onUnexpectedExternalError(e);
		}
		return [];
	}

	async provideSubtypes(item: TypeHierarchyItem, token: CancellationToken): Promise<TypeHierarchyItem[]> {
		try {
			const result = await this.provider.provideSubtypes(item, token);
			if (isNonEmptyArray(result)) {
				return result;
			}
		} catch (e) {
			onUnexpectedExternalError(e);
		}
		return [];
	}
}

// --- API command support

const _models = new Map<string, TypeHierarchyModel>();

CommandsRegistry.registerCommand('_executePrepareTypeHierarchy', async (accessor, ...args) => {
	const [resource, position] = args;
	assertType(URI.isUri(resource));
	assertType(Position.isIPosition(position));

	const modelService = accessor.get(IModelService);
	let textModel = modelService.getModel(resource);
	let textModelReference: IDisposable | undefined;
	if (!textModel) {
		const textModelService = accessor.get(ITextModelService);
		const result = await textModelService.createModelReference(resource);
		textModel = result.object.textEditorModel;
		textModelReference = result;
	}

	try {
		const model = await TypeHierarchyModel.create(textModel, position, CancellationToken.None);
		if (!model) {
			return [];
		}

		_models.set(model.id, model);
		_models.forEach((value, key, map) => {
			if (map.size > 10) {
				value.dispose();
				_models.delete(key);
			}
		});
		return [model.root];

	} finally {
		textModelReference?.dispose();
	}
});

function isTypeHierarchyItemDto(obj: any): obj is TypeHierarchyItem {
	const item = obj as TypeHierarchyItem;
	return typeof obj === 'object'
		&& typeof item.name === 'string'
		&& typeof item.kind === 'number'
		&& URI.isUri(item.uri)
		&& Range.isIRange(item.range)
		&& Range.isIRange(item.selectionRange);
}

CommandsRegistry.registerCommand('_executeProvideSupertypes', async (_accessor, ...args) => {
	const [item] = args;
	assertType(isTypeHierarchyItemDto(item));

	// find model
	const model = _models.get(item._sessionId);
	if (!model) {
		return undefined;
	}

	return model.provideSupertypes(item, CancellationToken.None);
});

CommandsRegistry.registerCommand('_executeProvideSubtypes', async (_accessor, ...args) => {
	const [item] = args;
	assertType(isTypeHierarchyItemDto(item));

	// find model
	const model = _models.get(item._sessionId);
	if (!model) {
		return undefined;
	}

	return model.provideSubtypes(item, CancellationToken.None);
});
