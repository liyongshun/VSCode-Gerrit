import {
	GerritChangeResponse,
	GerritCommentRange,
	GerritCommentResponse,
	GerritCommentSide,
	GerritCommentsResponse,
	GerritDetailedUserResponse,
} from './types';
import { FileCache } from '../../views/activityBar/changes/changeTreeView/file/fileCache';
import got, { OptionsOfTextResponseBody, Response } from 'got/dist/source';
import { optionalArrayEntry, optionalObjectProperty } from '../util';
import { DefaultChangeFilter, GerritChangeFilter } from './filters';
import { GerritComment, GerritDraftComment } from './gerritComment';
import { DEBUG_REQUESTS, READONLY_MODE } from '../constants';
import { FileMeta } from '../../providers/fileProvider';
import { getChangeCache } from '../gerritCache';
import { GerritChange } from './gerritChange';
import { getConfiguration } from '../config';
import { TextContent } from './gerritFile';
import { GerritUser } from './gerritUser';
import { URLSearchParams } from 'url';
import { window } from 'vscode';
import { log } from '../log';

export enum GerritAPIWith {
	LABELS = 'LABELS',
	DETAILED_LABELS = 'DETAILED_LABELS',
	DETAILED_ACCOUNTS = 'DETAILED_ACCOUNTS',
	CURRENT_REVISION = 'CURRENT_REVISION',
	CURRENT_COMMIT = 'CURRENT_COMMIT',
	CURRENT_FILES = 'CURRENT_FILES',
}

type WithValue<
	GC extends typeof GerritChange,
	V extends keyof InstanceType<GC>
> = {
	new (...args: ConstructorParameters<GC>): Omit<InstanceType<GC>, V> & {
		[K in V]: InstanceType<GC>[V] extends Promise<infer P>
			? Promise<Exclude<P, null | undefined>>
			: Exclude<InstanceType<GC>[V], null | undefined>;
	};
};

interface ResponseWithBody<T> extends Response<T> {
	strippedBody: string;
}

export interface ChangesOffsetParams {
	count?: number;
	offset?: number;
}

export class GerritAPI {
	private readonly _MAGIC_PREFIX = ")]}'";
	private _inFlightRequests: Map<string, Promise<ResponseWithBody<string>>> =
		new Map();

	private get _get(): OptionsOfTextResponseBody {
		return {
			method: 'GET',
			headers: this._headers(false),
		};
	}

	private get _put(): OptionsOfTextResponseBody {
		return {
			method: 'PUT',
			headers: this._headers(true),
		};
	}

	private get _delete(): OptionsOfTextResponseBody {
		return {
			method: 'DELETE',
			headers: this._headers(false),
		};
	}

	public constructor(
		private readonly _url: string,
		private readonly _username: string,
		private readonly _password: string
	) {}

	public static async performRequest(
		url: string,
		body?: OptionsOfTextResponseBody
	): Promise<ResponseWithBody<string>> {
		return (await got(url, {
			...body,
			https: {
				rejectUnauthorized: !getConfiguration().get(
					'gerrit.allowInvalidSSLCerts',
					false
				),
			},
		})) as ResponseWithBody<string>;
	}

	private _headers(withContent: boolean): Record<string, string | undefined> {
		return {
			Authorization:
				'Basic ' +
				Buffer.from(`${this._username}:${this._password}`).toString(
					'base64'
				),
			...optionalObjectProperty({
				'Content-Type': withContent ? 'application/json' : undefined,
			}),
		};
	}

	private _stripMagicPrefix(body: string): string {
		if (!body.startsWith(this._MAGIC_PREFIX)) {
			return body.trim();
		}
		return body.slice(this._MAGIC_PREFIX.length).trim();
	}

	private _stringify(rootValue: unknown): string {
		return JSON.stringify(rootValue, (_key, value) => {
			if (value instanceof URLSearchParams) {
				const obj: Record<string, string[]> = {};
				for (const key of value.keys()) {
					obj[key] = value.getAll(key);
				}
				return JSON.stringify(obj);
			}
			if (typeof value !== 'object' || !value) {
				return JSON.stringify(value);
			}

			return JSON.stringify(
				Object.fromEntries(
					Object.entries(value as Record<string, unknown>).map(
						(key, value) => {
							return [key, this._stringify(value)];
						}
					)
				)
			);
		});
	}

	private _createRequestID(
		url: string,
		body?: OptionsOfTextResponseBody
	): string {
		return `${url}|${this._stringify(body)}`;
	}

	/**
	 * Sometimes it happens that the same request is being
	 * performed in two places at the same time. It's kind of
	 * useless to perform it twice, so here we check if the
	 * request is the same as one that is in-flight and, if so,
	 * link up the responses.
	 */
	private async _syncUpSameRequests(
		url: string,
		body?: OptionsOfTextResponseBody
	): Promise<ResponseWithBody<string>> {
		// Non-get requests perform some remote action, we can't
		// just assume that that action only needs to happen once
		if (body && body.method !== 'GET') {
			return GerritAPI.performRequest(url, body);
		}

		const id = this._createRequestID(url, body);
		console.log(id);
		if (this._inFlightRequests.has(id)) {
			return this._inFlightRequests.get(id)!;
		}

		const req = GerritAPI.performRequest(url, body);
		this._inFlightRequests.set(id, req);
		const response = await req;
		this._inFlightRequests.delete(id);
		return response;
	}

	private async _tryRequest(
		url: string,
		body?: OptionsOfTextResponseBody
	): Promise<(Response<string> & { strippedBody: string }) | null> {
		if (READONLY_MODE && body?.method !== 'GET') {
			await window.showErrorMessage(
				'Canceled request trying to modify data in readonly mode'
			);
			return null;
		}
		log(`${body?.method || 'GET'} request to "${url}"`);
		if (DEBUG_REQUESTS) {
			console.log(body);
		}
		try {
			const response = await this._syncUpSameRequests(url, body);
			response.strippedBody = this._stripMagicPrefix(response.body);
			return response;
		} catch (e) {
			if (DEBUG_REQUESTS) {
				console.log(
					e,
					(e as { response: string }).response,
					(e as { response?: { body: string } }).response?.body
				);
			}
			await window.showErrorMessage(
				`Gerrit request to "${url}" failed. Please check your settings and/or connection`
			);
			return null;
		}
	}

	private _tryParseJSON<J>(text: string): J | null {
		try {
			return JSON.parse(text) as J;
		} catch (e) {
			return null;
		}
	}

	private _assertResponse(
		response: null | Response<string>
	): response is Response<string> {
		if (!response) {
			log('Invalid response');
			return false;
		}
		return true;
	}

	private _assertRequestSucceeded(response: Response<string>): boolean {
		const succeeded =
			response.statusCode > 199 && response.statusCode < 300;
		if (!succeeded) {
			log(`Request failed: ${response.statusCode}`);
		}
		return succeeded;
	}

	private _handleResponse<T>(
		response:
			| null
			| (Response<string> & {
					strippedBody: string;
			  })
	): T | null {
		if (
			!this._assertResponse(response) ||
			!this._assertRequestSucceeded(response)
		) {
			return null;
		}
		const parsed = this._tryParseJSON<T>(response.strippedBody);
		if (!parsed) {
			log(`Failed to parse response JSON: ${response.strippedBody}`);
			return null;
		}
		return parsed;
	}

	private async _getCommentsShared(
		changeID: string,
		type: 'drafts' | 'comments'
	): Promise<GerritCommentsResponse | null> {
		const response = await this._tryRequest(
			this.getURL(`changes/${changeID}/${type}/`),
			this._get
		);

		return this._handleResponse<GerritCommentsResponse>(response);
	}

	public async testConnection(): Promise<boolean> {
		const response = await this._tryRequest(
			this.getURL('config/server/version'),
			this._get
		);
		return response?.statusCode === 200;
	}

	/**
	 * Gets the path to given URL. Note that the trailing slash
	 * is included.
	 */
	public getURL(path: string, auth: boolean = true): string {
		const trailingSlash = this._url.endsWith('/') ? '' : '/';
		const authStr = auth ? 'a/' : '';
		return `${this._url}${trailingSlash}${authStr}${path}`;
	}

	public async getChange(
		changeID: string,
		...withValues: never[]
	): Promise<GerritChange | null>;
	public async getChange(
		changeID: string,
		...withValues: GerritAPIWith.LABELS[]
	): Promise<InstanceType<WithValue<typeof GerritChange, 'labels'>> | null>;
	public async getChange(
		changeID: string,
		...withValues: GerritAPIWith.DETAILED_LABELS[]
	): Promise<InstanceType<
		WithValue<typeof GerritChange, 'detailedLabels'>
	> | null>;
	public async getChange(
		changeID: string,
		...withValues: GerritAPIWith[]
	): Promise<GerritChange | null>;
	public async getChange(
		changeID: string,
		...withValues: GerritAPIWith[]
	): Promise<GerritChange | null> {
		const response = await this._tryRequest(
			this.getURL(`changes/${changeID}/detail/`),
			{
				...this._get,
				searchParams: new URLSearchParams(
					withValues.map((v) => ['o', v] as [string, string])
				),
			}
		);

		const json = this._handleResponse<GerritChangeResponse>(response);
		if (!json) {
			return null;
		}

		const change = new GerritChange(json);
		getChangeCache().set(changeID, withValues, change);
		return change;
	}

	public async getChanges(
		filters: (DefaultChangeFilter | GerritChangeFilter)[][],
		offsetParams: ChangesOffsetParams | undefined,
		...withValues: never[]
	): Promise<GerritChange[]>;
	public async getChanges(
		filters: (DefaultChangeFilter | GerritChangeFilter)[][],
		offsetParams: ChangesOffsetParams | undefined,
		...withValues: GerritAPIWith.LABELS[]
	): Promise<InstanceType<WithValue<typeof GerritChange, 'labels'>>[]>;
	public async getChanges(
		filters: (DefaultChangeFilter | GerritChangeFilter)[][],
		offsetParams: ChangesOffsetParams | undefined,
		...withValues: GerritAPIWith.DETAILED_LABELS[]
	): Promise<
		InstanceType<WithValue<typeof GerritChange, 'detailedLabels'>>[]
	>;
	public async getChanges(
		filters: (DefaultChangeFilter | GerritChangeFilter)[][],
		offsetParams: ChangesOffsetParams | undefined,
		...withValues: GerritAPIWith[]
	): Promise<GerritChange[]>;
	public async getChanges(
		filters: (DefaultChangeFilter | GerritChangeFilter)[][],
		offsetParams: ChangesOffsetParams | undefined,
		...withValues: GerritAPIWith[]
	): Promise<GerritChange[]> {
		console.log(
			...filters.map((filter) => {
				return ['q', filter.join(' ')] as [string, string];
			})
		);
		const response = await this._tryRequest(this.getURL('changes/'), {
			...this._get,
			searchParams: new URLSearchParams([
				...filters.map((filter) => {
					return ['q', filter.join(' ')] as [string, string];
				}),
				...withValues.map((v) => ['o', v] as [string, string]),
				...optionalArrayEntry(
					typeof offsetParams?.count === 'number',
					() => [
						['n', String(offsetParams!.count)] as [string, string],
					]
				),
				...optionalArrayEntry(
					typeof offsetParams?.offset === 'number',
					() => [
						['S', String(offsetParams!.offset)] as [string, string],
					]
				),
			]),
		});

		const json = this._handleResponse<GerritChangeResponse[]>(response);
		if (!json) {
			return [];
		}

		const changes = json.map((p) => new GerritChange(p));
		const cache = getChangeCache();
		changes.forEach((change) =>
			cache.set(change.change_id, withValues, change)
		);
		return changes;
	}

	public async getComments(
		changeID: string
	): Promise<Map<string, GerritComment[]>> {
		const json = await this._getCommentsShared(changeID, 'comments');
		if (!json) {
			return new Map();
		}

		const map = new Map<string, GerritComment[]>();
		for (const filePath in json) {
			const comments = json[filePath];
			map.set(
				filePath,
				await Promise.all(
					comments.map((c) =>
						GerritComment.from(changeID, filePath, c)
					)
				)
			);
		}
		return map;
	}

	public async getDraftComments(
		changeID: string
	): Promise<Map<string, GerritDraftComment[]>> {
		const json = await this._getCommentsShared(changeID, 'drafts');
		if (!json) {
			return new Map();
		}

		const map = new Map<string, GerritDraftComment[]>();
		for (const filePath in json) {
			const comments = json[filePath];
			map.set(
				filePath,
				await Promise.all(
					comments.map((c) =>
						GerritDraftComment.from(changeID, filePath, c)
					)
				)
			);
		}
		return map;
	}

	public async getFileContent({
		project,
		commit,
		changeID,
		filePath,
	}: {
		project: string;
		commit: string;
		changeID: string;
		filePath: string;
	}): Promise<TextContent | null> {
		if (FileCache.has(project, commit, filePath)) {
			return FileCache.get(project, commit, filePath);
		}

		const response = await this._tryRequest(
			this.getURL(
				`projects/${project}/commits/${commit}/files/${encodeURIComponent(
					filePath
				)}/content`
			),
			this._get
		);

		if (
			!this._assertResponse(response) ||
			!this._assertRequestSucceeded(response)
		) {
			return null;
		}

		const textContent = TextContent.from(
			FileMeta.createFileMeta({
				project,
				commit,
				filePath,
				changeID,
			}),
			response.body,
			'base64'
		);
		if (!textContent) {
			return null;
		}

		FileCache.set(project, commit, filePath, textContent);
		return textContent;
	}

	public async createDraftComment({
		content,
		changeID,
		revision,
		filePath,
		unresolved,
		side,
		lineOrRange,
		replyTo,
	}: {
		content: string;
		changeID: string;
		revision: string;
		filePath: string;
		unresolved: boolean;
		side: GerritCommentSide | undefined;
		lineOrRange?: number | GerritCommentRange;
		replyTo?: string;
	}): Promise<GerritDraftComment | null> {
		const response = await this._tryRequest(
			this.getURL(`changes/${changeID}/revisions/${revision}/drafts`),
			{
				...this._put,
				body: JSON.stringify({
					path: filePath,
					line:
						typeof lineOrRange === 'number'
							? lineOrRange
							: undefined,
					range:
						lineOrRange && typeof lineOrRange === 'object'
							? lineOrRange
							: undefined,
					in_reply_to: replyTo,
					message: content,
					unresolved,
					side,
				}),
			}
		);

		const json = this._handleResponse<GerritCommentResponse>(response);
		if (!json) {
			return null;
		}

		return GerritDraftComment.from(changeID, filePath, json);
	}

	public async createPatchSetLevelDraftComment({
		content,
		changeID,
		revision,
		filePath,
		unresolved,
		replyTo,
	}: {
		content: string;
		changeID: string;
		revision: string;
		filePath: string;
		unresolved: boolean;
		replyTo?: string;
	}): Promise<GerritDraftComment | null> {
		const response = await this._tryRequest(
			this.getURL(`changes/${changeID}/revisions/${revision}/drafts`),
			{
				...this._put,
				body: JSON.stringify({
					path: filePath,
					in_reply_to: replyTo,
					message: content,
					unresolved,
				}),
			}
		);

		const json = this._handleResponse<GerritCommentResponse>(response);
		if (!json) {
			return null;
		}

		return GerritDraftComment.from(changeID, filePath, json);
	}

	public async updateDraftComment({
		draft,
		changes,
	}: {
		draft: GerritDraftComment;
		changes: {
			content?: string;
			unresolved?: boolean;
		};
	}): Promise<GerritDraftComment | null> {
		const response = await this._tryRequest(
			this.getURL(
				`changes/${draft.changeID}/revisions/${draft.commitID}/drafts/${draft.id}`
			),
			{
				...this._put,
				body: JSON.stringify({
					commit_id: draft.commitID,
					id: draft.id,
					line: draft.line,
					range: draft.range,
					path: draft.filePath,
					updated: draft.updated.source,
					message: changes.content,
					unresolved: changes.unresolved,
					patch_set: draft.patchSet,
					__draft: true,
				}),
			}
		);

		const json = this._handleResponse<GerritCommentResponse>(response);
		if (!json) {
			return null;
		}

		return GerritDraftComment.from(draft.changeID, draft.filePath, json);
	}

	public async deleteDraftComment(
		draft: GerritDraftComment
	): Promise<boolean> {
		const response = await this._tryRequest(
			this.getURL(
				`changes/${draft.changeID}/revisions/${draft.commitID}/drafts/${draft.id}`
			),
			this._delete
		);

		return (
			this._assertResponse(response) &&
			this._assertRequestSucceeded(response)
		);
	}

	public async getSelf(): Promise<GerritUser | null> {
		const response = await this._tryRequest(
			this.getURL('accounts/self'),
			this._get
		);

		const json = this._handleResponse<GerritDetailedUserResponse>(response);
		if (!json) {
			return null;
		}

		return new GerritUser(json);
	}
}
