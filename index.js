(function () {
    'use strict';

    const VERSION = '0.4.1';
    const POS_KEY = 'stdh4c.position.v1';
    const LOG_PREFIX = '[STDH4C]';

    const state = {
        events: [],
        generationSeq: 0,
        currentGeneration: null,
        lastGeneration: null,
        pendingMessageSentAt: 0,
        stopHintAt: 0,
        stopHintReason: '',
        lastManualStopLogAt: 0,
        lastStoppedLogAt: 0,
        lastMessageReceivedLogAt: 0,
        eventBound: false,
        stopDomBound: false,
        dragBound: false,
        renderScheduled: false,
        sessionVisible: false,
        http: {
            bound: false,
            disabledReason: '',
            originalFetch: null,
            errors: [],
            maxErrors: 60
        }
    };

    function nowIso() {
        return new Date().toISOString();
    }

    function shortTime() {
        return new Date().toLocaleTimeString();
    }

    function getCtx() {
        return globalThis.SillyTavern?.getContext?.() || null;
    }

    function safe(fn, fallback) {
        try {
            const value = fn();
            return value ?? fallback;
        } catch {
            return fallback;
        }
    }

    function scheduleRender() {
        if (state.renderScheduled) return;

        state.renderScheduled = true;

        setTimeout(function () {
            state.renderScheduled = false;
            render();
        }, 50);
    }

    function trimEvents() {
        if (state.events.length > 100) {
            state.events = state.events.slice(-100);
        }
    }

    function addEvent(name, detail, generationId) {
        state.events.push({
            time: nowIso(),
            shortTime: shortTime(),
            name,
            detail: detail || '',
            generationId: generationId || null
        });

        trimEvents();
        scheduleRender();
    }

    function summarizePayload(payload) {
        if (payload === null || payload === undefined) return '';

        if (typeof payload === 'string') {
            return `[string length=${payload.length}]`;
        }

        if (typeof payload === 'number' || typeof payload === 'boolean') {
            return String(payload);
        }

        if (Array.isArray(payload)) {
            return `[array length=${payload.length}]`;
        }

        if (typeof payload === 'object') {
            const blocked = [
                'mes',
                'message',
                'messages',
                'content',
                'prompt',
                'text',
                'chat',
                'history',
                'description',
                'personality',
                'scenario',
                'first_mes'
            ];

            const keys = Object.keys(payload)
                .filter(key => !blocked.includes(key))
                .slice(0, 8);

            return `[object keys=${keys.join(',')}]`;
        }

        return `[${typeof payload}]`;
    }

    function getSnapshot() {
        const ctx = getCtx();

        if (!ctx) {
            return {
                ready: false,
                api: '(context not ready)',
                source: '(unknown)',
                model: '(unknown)',
                preset: '(unknown)',
                messages: '(unknown)',
                character: '(unknown)',
                chatId: '(unknown)',
                legacyDetected: Boolean(globalThis.STDiagnosticHelper || globalThis.STDH4)
            };
        }

        const characterId = ctx.characterId;
        const character = Number.isInteger(characterId)
            ? ctx.characters?.[characterId]
            : null;

        const presetManager = safe(() => ctx.getPresetManager?.(), null);

        return {
            ready: true,
            api: ctx.mainApi || ctx.main_api || '(unknown)',
            source: ctx.chatCompletionSettings?.chat_completion_source || '(n/a)',
            model:
                safe(() => ctx.getChatCompletionModel?.(), null) ||
                ctx.chatCompletionSettings?.openai_model ||
                ctx.chatCompletionSettings?.model ||
                ctx.textCompletionSettings?.model ||
                '(unknown)',
            preset:
                safe(() => presetManager?.getSelectedPresetName?.(), null) ||
                safe(() => presetManager?.getCurrentPresetName?.(), null) ||
                safe(() => presetManager?.activePreset?.name, null) ||
                '(unknown)',
            messages: Array.isArray(ctx.chat) ? ctx.chat.length : '(unknown)',
            character: character?.name || character?.data?.name || ctx.name2 || '(none)',
            chatId: ctx.chatId || safe(() => ctx.getCurrentChatId?.(), '(unknown)'),
            legacyDetected: Boolean(globalThis.STDiagnosticHelper || globalThis.STDH4)
        };
    }

    function createGeneration(triggerType) {
        const id = ++state.generationSeq;

        const now = nowIso();

        state.currentGeneration = {
            id,
            startedAt: now,
            endedAt: null,
            firstStreamAt: null,
            durationMs: 0,
            firstTokenLatencyMs: null,
            streamTokens: 0,
            stopped: false,
            stoppedSource: '',
            messageReceived: false,
            messageSentSeen: Date.now() - state.pendingMessageSentAt < 5000,
            triggerType: triggerType || (
                Date.now() - state.pendingMessageSentAt < 5000
                    ? 'user message'
                    : 'regenerate / continue / unknown'
            )
        };

        return state.currentGeneration;
    }

    function ensureGeneration() {
        if (!state.currentGeneration) {
            createGeneration('implicit / unknown');
        }

        return state.currentGeneration;
    }

    function onMessageSent(data) {
        state.pendingMessageSentAt = Date.now();

        if (state.currentGeneration) {
            state.currentGeneration.messageSentSeen = true;
            state.currentGeneration.triggerType = 'user message';
        }

        addEvent(
            'MESSAGE_SENT',
            summarizePayload(data),
            state.currentGeneration?.id || null
        );
    }

    function onGenerationStarted(data) {
        const gen = createGeneration();

        addEvent('GENERATION_STARTED', summarizePayload(data), gen.id);
    }

    function onStreamToken(data) {
        const gen = ensureGeneration();

        gen.streamTokens += 1;

        if (!gen.firstStreamAt) {
            gen.firstStreamAt = nowIso();
            gen.firstTokenLatencyMs =
                new Date(gen.firstStreamAt).getTime() -
                new Date(gen.startedAt).getTime();

            addEvent('STREAM_TOKEN_RECEIVED_FIRST', summarizePayload(data), gen.id);
        }

        scheduleRender();
    }

    function isNearGeneration(gen, nowMs) {
        if (!gen) return false;

        const start = Date.parse(gen.startedAt || '');
        const end = Date.parse(gen.endedAt || '');

        if (!Number.isFinite(start)) return false;

        if (Number.isFinite(end)) {
            return nowMs >= start - 3000 && nowMs <= end + 15000;
        }

        return nowMs >= start - 3000;
    }

    function markManualStop(reason) {
        const now = Date.now();
        const finalReason = reason || 'manual stop hint';

        state.stopHintAt = now;
        state.stopHintReason = finalReason;

        if (state.currentGeneration) {
            state.currentGeneration.stopped = true;
            state.currentGeneration.stoppedSource = finalReason;
        }

        if (isNearGeneration(state.lastGeneration, now)) {
            state.lastGeneration.stopped = true;
            state.lastGeneration.stoppedSource = finalReason;
        }

        if (now - state.lastManualStopLogAt > 900) {
            state.lastManualStopLogAt = now;
            addEvent(
                'MANUAL_STOP_HINT',
                finalReason,
                state.currentGeneration?.id || state.lastGeneration?.id || null
            );
        }
    }

    function onGenerationStopped(data) {
        const now = Date.now();

        if (state.currentGeneration) {
            state.currentGeneration.stopped = true;
            state.currentGeneration.stoppedSource = 'GENERATION_STOPPED event';
        } else if (isNearGeneration(state.lastGeneration, now)) {
            state.lastGeneration.stopped = true;
            state.lastGeneration.stoppedSource = 'GENERATION_STOPPED event';
        }

        if (now - state.lastStoppedLogAt > 900) {
            state.lastStoppedLogAt = now;
            addEvent(
                'GENERATION_STOPPED',
                summarizePayload(data),
                state.currentGeneration?.id || state.lastGeneration?.id || null
            );
        }
    }

    function onMessageReceived(data) {
        const now = Date.now();

        if (state.currentGeneration) {
            state.currentGeneration.messageReceived = true;
        } else if (isNearGeneration(state.lastGeneration, now)) {
            state.lastGeneration.messageReceived = true;
        }

        if (now - state.lastMessageReceivedLogAt > 500) {
            state.lastMessageReceivedLogAt = now;
            addEvent(
                'MESSAGE_RECEIVED',
                summarizePayload(data),
                state.currentGeneration?.id || state.lastGeneration?.id || null
            );
        }
    }

    function onGenerationEnded(data) {
        const gen = state.currentGeneration;

        if (gen) {
            gen.endedAt = nowIso();
            gen.durationMs =
                new Date(gen.endedAt).getTime() -
                new Date(gen.startedAt).getTime();

            if (
                state.stopHintAt &&
                state.stopHintAt >= new Date(gen.startedAt).getTime() - 3000 &&
                state.stopHintAt <= new Date(gen.endedAt).getTime() + 15000
            ) {
                gen.stopped = true;
                gen.stoppedSource = state.stopHintReason || 'manual stop hint';
            }

            state.lastGeneration = { ...gen };
            state.currentGeneration = null;
        }

        addEvent(
            'GENERATION_ENDED',
            summarizePayload(data),
            state.lastGeneration?.id || null
        );
    }

    function bindOne(ctx, eventTypes, key, handler) {
        const eventName = eventTypes[key];

        if (!eventName || !ctx?.eventSource || typeof ctx.eventSource.on !== 'function') {
            return;
        }

        ctx.eventSource.on(eventName, handler);
    }

    function bindEvents() {
        if (state.eventBound) return true;

        const ctx = getCtx();
        const eventTypes = ctx?.event_types || ctx?.eventTypes || {};

        if (!ctx?.eventSource || !eventTypes || Object.keys(eventTypes).length === 0) {
            return false;
        }

        bindOne(ctx, eventTypes, 'MESSAGE_SENT', onMessageSent);
        bindOne(ctx, eventTypes, 'GENERATION_STARTED', onGenerationStarted);
        bindOne(ctx, eventTypes, 'STREAM_TOKEN_RECEIVED', onStreamToken);
        bindOne(ctx, eventTypes, 'GENERATION_STOPPED', onGenerationStopped);
        bindOne(ctx, eventTypes, 'GENERATION_ENDED', onGenerationEnded);
        bindOne(ctx, eventTypes, 'MESSAGE_RECEIVED', onMessageReceived);

        bindOne(ctx, eventTypes, 'SETTINGS_UPDATED', data => {
            addEvent('SETTINGS_UPDATED', summarizePayload(data));
        });

        bindOne(ctx, eventTypes, 'PRESET_CHANGED', data => {
            addEvent('PRESET_CHANGED', summarizePayload(data));
        });

        bindOne(ctx, eventTypes, 'MAIN_API_CHANGED', data => {
            addEvent('MAIN_API_CHANGED', summarizePayload(data));
        });

        bindOne(ctx, eventTypes, 'CHATCOMPLETION_SOURCE_CHANGED', data => {
            addEvent('CHATCOMPLETION_SOURCE_CHANGED', summarizePayload(data));
        });

        bindOne(ctx, eventTypes, 'CHATCOMPLETION_MODEL_CHANGED', data => {
            addEvent('CHATCOMPLETION_MODEL_CHANGED', summarizePayload(data));
        });

        bindOne(ctx, eventTypes, 'WORLDINFO_UPDATED', data => {
            addEvent('WORLDINFO_UPDATED', summarizePayload(data));
        });

        bindOne(ctx, eventTypes, 'WORLDINFO_SETTINGS_UPDATED', data => {
            addEvent('WORLDINFO_SETTINGS_UPDATED', summarizePayload(data));
        });

        bindOne(ctx, eventTypes, 'PERSONA_CHANGED', data => {
            addEvent('PERSONA_CHANGED', summarizePayload(data));
        });

        state.eventBound = true;
        addEvent('EVENTS_BOUND');

        return true;
    }

    function bindStopDom() {
        if (state.stopDomBound) return;

        function isGenerating() {
            return Boolean(state.currentGeneration);
        }

        function looksLikeStopButton(target) {
            if (!target || !isGenerating()) return false;

            let el = target;

            for (let i = 0; i < 7 && el && el !== document.body; i += 1) {
                const info = [
                    el.id || '',
                    typeof el.className === 'string' ? el.className : '',
                    el.getAttribute?.('title') || '',
                    el.getAttribute?.('aria-label') || '',
                    el.textContent?.trim?.().slice(0, 40) || ''
                ].join(' ');

                if (/mes_stop|fa-stop|stop|abort|cancel|停止|中止|取消生成|停止生成/i.test(info)) {
                    return true;
                }

                el = el.parentElement;
            }

            return false;
        }

        function watch(event) {
            if (looksLikeStopButton(event.target)) {
                markManualStop('stop button click');
            }
        }

        document.addEventListener('pointerdown', watch, true);
        document.addEventListener('click', watch, true);

        state.stopDomBound = true;
        addEvent('STOP_DOM_BOUND');
    }

    function safeUrl(rawUrl) {
        try {
            const url = new URL(String(rawUrl), location.origin);
            const sameOrigin = url.origin === location.origin;
            const prefix = sameOrigin ? 'local' : 'external';
            return `${prefix}:${url.pathname}`;
        } catch {
            return '[unparsed-url]';
        }
    }

    function inputUrl(input) {
        if (typeof input === 'string') return input;
        if (input && typeof input.url === 'string') return input.url;
        return String(input || '');
    }

    function methodOf(input, init) {
        return String(
            init?.method ||
            input?.method ||
            'GET'
        ).toUpperCase();
    }

    function normalizePath(item) {
        return String(item?.url || '').replace(/^(local|external):/, '');
    }

    function isTestRequest(item) {
        const path = normalizePath(item);
        return path.includes('__stdh4c_test_404') ||
            path.includes('__stdh4_test_404') ||
            path.includes('__stdh_test_404');
    }

    function isBackgroundEndpoint(path) {
        return [
            /^\/api\/extensions(\/|$)/i,
            /^\/api\/assets(\/|$)/i,
            /^\/api\/settings(\/|$)/i,
            /^\/api\/users(\/|$)/i,
            /^\/api\/plugins(\/|$)/i,
            /^\/api\/secrets(\/|$)/i
        ].some(pattern => pattern.test(path));
    }

    function isGenerationEndpoint(path) {
        return [
            /^\/api\/backends\/.*generate/i,
            /^\/api\/(chat|generate|send)(\/|$)/i,
            /\/v1\/chat\/completions$/i,
            /\/v1\/completions$/i,
            /\/chat\/completions$/i,
            /\/completions$/i,
            /\/generate$/i
        ].some(pattern => pattern.test(path));
    }

    function classifyHttp(item) {
        const path = normalizePath(item);

        if (isTestRequest(item)) return 'test';
        if (isGenerationEndpoint(path)) return 'generation';
        if (isBackgroundEndpoint(path)) return 'background';

        return 'unknown';
    }

    function labelOf(category) {
        if (category === 'generation') return '生成相关';
        if (category === 'background') return '后台/扩展';
        if (category === 'test') return '测试请求';
        return '未分类';
    }

    function explainHttp(item) {
        const status = item.status;
        const category = item.category || classifyHttp(item);
        const path = normalizePath(item);

        if (category === 'background') {
            if (path.startsWith('/api/extensions/version')) {
                return '后台扩展版本检查失败，常见原因是 GitHub 访问失败、扩展仓库不可达或网络/TLS 中断；通常不代表本次模型生成失败。';
            }

            return '后台接口错误，可能与扩展、设置、资源或本地服务有关；不一定影响本次模型生成。';
        }

        if (category === 'test') {
            return '插件测试请求，可忽略。';
        }

        if (status === 400) return '生成接口 400：请求参数、模型名、预设或接口格式可能不兼容。';
        if (status === 401) return '生成接口 401：鉴权失败，优先检查 API key、secret 或登录状态。';
        if (status === 403) return '生成接口 403：权限或策略拒绝，可能与地区、模型权限、账号状态、公益站/第三方平台规则有关。';
        if (status === 404) return '生成接口 404：请求路径、接口地址或模型路由可能不存在。';
        if (status === 429) return '生成接口 429：频率限制、额度不足、并发过高、公益站限流或第三方平台限流。';
        if (status === 'NETWORK_ERROR') return '生成接口网络错误：可能是网络断开、CORS、连接重置或后端不可达。';

        if (typeof status === 'number' && status >= 500) {
            return `生成接口 ${status}：可能与后端、反代、上游服务、网络链路或请求格式有关。`;
        }

        return `HTTP ${status}：需要结合路径分类和控制台继续判断。`;
    }

    function recordHttpError(info) {
        const base = {
            at: nowIso(),
            shortTime: shortTime(),
            status: info.status,
            method: info.method || 'GET',
            url: safeUrl(info.url || ''),
            durationMs: Math.round(info.durationMs || 0)
        };

        const category = classifyHttp(base);

        const item = {
            ...base,
            category,
            label: labelOf(category)
        };

        item.explanation = explainHttp(item);

        state.http.errors.push(item);

        if (state.http.errors.length > state.http.maxErrors) {
            state.http.errors = state.http.errors.slice(-state.http.maxErrors);
        }

        console.warn('[STDH4C HTTP]', item);
        scheduleRender();
    }

    function installHttpMonitor() {
        if (state.http.bound || state.http.disabledReason) {
            return true;
        }

        if (globalThis.STDHHttpMonitor || globalThis.STDH4Alpha3 || window.fetch.__stdh4HttpWrapped) {
            state.http.disabledReason = '检测到其他 ST 诊断插件 HTTP monitor。请只启用 v0.4 Clean 后再测试 HTTP。';
            scheduleRender();
            return true;
        }

        if (window.fetch.__stdh4cWrapped) {
            state.http.bound = true;
            return true;
        }

        state.http.originalFetch = window.fetch;

        window.fetch = async function stdh4cFetchWrapper(input, init) {
            const start = performance.now();
            const url = inputUrl(input);
            const method = methodOf(input, init);

            try {
                const response = await state.http.originalFetch.apply(this, arguments);
                const durationMs = performance.now() - start;

                if (response && response.status >= 400) {
                    recordHttpError({
                        status: response.status,
                        method,
                        url,
                        durationMs
                    });
                }

                return response;
            } catch (error) {
                const durationMs = performance.now() - start;

                recordHttpError({
                    status: 'NETWORK_ERROR',
                    method,
                    url,
                    durationMs
                });

                throw error;
            }
        };

        window.fetch.__stdh4cWrapped = true;
        state.http.bound = true;

        addEvent('HTTP_MONITOR_BOUND');

        return true;
    }

    function allHttpErrors() {
        return state.http.errors || [];
    }

    function realHttpErrors() {
        return allHttpErrors().filter(item => item.category !== 'test');
    }

    function testHttpErrors() {
        return allHttpErrors().filter(item => item.category === 'test');
    }

    function compactHttpGroups(errors) {
        const groups = [];

        for (const item of errors || []) {
            const key = [
                item.category,
                item.status,
                item.method,
                item.url,
                item.explanation
            ].join('|');

            const last = groups[groups.length - 1];

            if (last && last.key === key) {
                last.count += 1;
                last.endTime = item.shortTime;
                last.minDuration = Math.min(last.minDuration, item.durationMs || 0);
                last.maxDuration = Math.max(last.maxDuration, item.durationMs || 0);
            } else {
                groups.push({
                    key,
                    category: item.category,
                    label: item.label,
                    status: item.status,
                    method: item.method,
                    url: item.url,
                    explanation: item.explanation,
                    count: 1,
                    startTime: item.shortTime,
                    endTime: item.shortTime,
                    minDuration: item.durationMs || 0,
                    maxDuration: item.durationMs || 0
                });
            }
        }

        return groups;
    }

    function durationText(group) {
        if (group.minDuration === group.maxDuration) {
            return `${group.minDuration}ms`;
        }

        return `${group.minDuration}-${group.maxDuration}ms`;
    }

    function formatHttpGroup(group) {
        const time = group.count > 1
            ? `${group.startTime}-${group.endTime}`
            : group.startTime;

        const count = group.count > 1 ? ` × ${group.count}` : '';

        return `${time} | ${group.label} | HTTP_${group.status}${count} | ${group.method} ${group.url} | ${durationText(group)} | ${group.explanation}`;
    }


    function generationHttpErrors() {
        return realHttpErrors().filter(x => x.category === 'generation');
    }

    function backgroundHttpErrors() {
        return realHttpErrors().filter(x => x.category === 'background');
    }

    function unknownHttpErrors() {
        return realHttpErrors().filter(x => x.category === 'unknown');
    }

    function linkHealth() {
        const genErr = generationHttpErrors();
        const bgErr = backgroundHttpErrors();
        const unkErr = unknownHttpErrors();
        const last = state.lastGeneration;

        if (genErr.length) {
            const e = genErr[genErr.length - 1];
            return {
                status: 'Generation HTTP Error',
                reason: `捕获到生成相关 HTTP ${e.status}：${e.explanation}`
            };
        }

        if (!last) {
            return { status: 'Incomplete', reason: '还没有捕获完整生成。' };
        }

        if (last.stopped) {
            return {
                status: 'User Stopped',
                reason: '最近一次生成被用户手动停止。若回复不完整，通常不应归因于模型或 API 失败。'
            };
        }

        if (!last.messageReceived) {
            return {
                status: 'Incomplete',
                reason: '最近一次生成结束，但未确认收到回复事件。'
            };
        }

        if (last.streamTokens === 0) {
            return {
                status: 'Stream Unclear',
                reason: '最近一次生成没有捕获流式 chunk/token。若启用了流式，建议检查接口流式兼容。'
            };
        }

        if (bgErr.length) {
            return {
                status: 'Healthy with Background Notice',
                reason: '生成链路正常，但捕获到后台/扩展 HTTP 提示。'
            };
        }

        if (unkErr.length) {
            return {
                status: 'Healthy with Unknown HTTP Notice',
                reason: '生成链路正常，但捕获到未分类 HTTP 错误。'
            };
        }

        return {
            status: 'Healthy',
            reason: '最近生成链路正常，未发现明显生成相关风险。'
        };
    }


    // STDH4C_STUCK_FIX_V041
    function parseTimeMs(value) {
        const t = Date.parse(value || '');
        return Number.isFinite(t) ? t : 0;
    }

    function currentGenerationAgeMs() {
        if (!state.currentGeneration) return 0;
        const start = parseTimeMs(state.currentGeneration.startedAt);
        return start ? Date.now() - start : 0;
    }

    function currentLooksOrphan() {
        const cur = state.currentGeneration;
        const last = state.lastGeneration;

        if (!cur) return false;

        const age = currentGenerationAgeMs();
        const noSignal =
            !cur.firstStreamAt &&
            !cur.messageReceived &&
            (cur.streamTokens || 0) === 0;

        if (!noSignal) return false;

        const curStart = parseTimeMs(cur.startedAt);
        const lastEnd = parseTimeMs(last?.endedAt);

        const afterCompletedLast =
            Boolean(lastEnd) &&
            Boolean(curStart) &&
            curStart >= lastEnd - 1000;

        const noMessageSent =
            !cur.messageSentSeen &&
            cur.triggerType !== 'user message';

        if (afterCompletedLast && age > 15000) return true;
        if (noMessageSent && age > 45000) return true;

        return false;
    }

    function sanitizeGenerationState(source) {
        if (!state.currentGeneration) return false;

        if (currentLooksOrphan()) {
            const orphanId = state.currentGeneration.id || null;
            state.currentGeneration = null;

            addEvent(
                'ORPHAN_GENERATION_DROPPED',
                source || 'watchdog',
                orphanId
            );

            return true;
        }

        return false;
    }


    function generationSummary() {
        sanitizeGenerationState('summary');
        const cur = state.currentGeneration;
        const last = state.lastGeneration;

        if (cur) {
            const sec = Math.round((Date.now() - new Date(cur.startedAt).getTime()) / 1000);
            return `正在生成：已耗时 ${sec} 秒；已捕获 ${cur.streamTokens || 0} 次 chunk/token。`;
        }

        if (!last) return '最近生成：尚未捕获完整生成。';

        const parts = [];
        parts.push('最近生成：已结束');
        parts.push(`耗时 ${Math.round((last.durationMs || 0) / 1000)} 秒`);

        if (last.firstTokenLatencyMs !== null && last.firstTokenLatencyMs !== undefined) {
            parts.push(`首 chunk 延迟 ${Math.round(last.firstTokenLatencyMs / 1000)} 秒`);
        } else {
            parts.push('未捕获首 chunk 延迟');
        }

        parts.push(`已捕获 ${last.streamTokens || 0} 次 chunk/token`);
        parts.push(`触发类型：${last.triggerType || 'unknown'}`);
        parts.push(last.stopped ? '停止状态：用户手动停止' : '停止状态：正常结束');

        return parts.join('；');
    }

    function riskText() {
        sanitizeGenerationState('risk');
        const health = linkHealth();

        if (health.status === 'Generation HTTP Error') return health.reason;

        if (state.currentGeneration) {
            return '当前正在生成。若长时间没有首 chunk，可能需要检查上游响应、网络或请求端状态。';
        }

        if (!state.lastGeneration) {
            return '还没有捕获完整生成。请先发送一条消息测试生成链路。';
        }

        if (state.lastGeneration.stopped) {
            return '最近一次生成被标记为用户手动停止。若回复不完整，通常不应归因于模型或 API 失败。';
        }

        if (state.lastGeneration.streamTokens === 0) {
            return '最近一次生成未捕获流式事件。若你启用了流式，建议检查接口流式兼容或网络链路。';
        }

        return '最近生成链路正常，未发现明显生成链路风险。';
    }

    function compactEvents(events) {
        const groups = [];

        for (const e of events || []) {
            const last = groups[groups.length - 1];

            if (last && last.name === e.name && last.detail === e.detail) {
                last.count += 1;
                last.end = e.shortTime;
            } else {
                groups.push({
                    name: e.name,
                    detail: e.detail || '',
                    count: 1,
                    start: e.shortTime,
                    end: e.shortTime
                });
            }
        }

        return groups.map(x => {
            const t = x.count > 1 ? `${x.start}-${x.end}` : x.start;
            const c = x.count > 1 ? ` × ${x.count}` : '';
            const d = x.detail ? ` | ${x.detail}` : '';
            return `${t} | ${x.name}${c}${d}`;
        });
    }

    function recentGenerationTimeline() {
        const last = state.lastGeneration;
        if (!last) return [];
        return compactEvents(state.events.filter(e => e.generationId === last.id));
    }

    function sessionTimeline() {
        return compactEvents(state.events).slice(-30);
    }

    function generationImpactLines() {
        const gen = generationHttpErrors();
        const bg = backgroundHttpErrors();
        const unk = unknownHttpErrors();
        const last = state.lastGeneration;

        if (gen.length) {
            const e = gen[gen.length - 1];
            return [
                'Generation Impact: generation-related HTTP error captured.',
                `Latest generation-related error: HTTP_${e.status} ${e.method} ${e.url}.`,
                e.explanation
            ];
        }

        if (last && bg.length) {
            return [
                'Generation Impact: no generation-related HTTP errors captured.',
                'Background / extension HTTP notices were captured, but the latest generation completed normally.'
            ];
        }

        if (last && unk.length) {
            return [
                'Generation Impact: no classified generation HTTP errors captured.',
                'Unknown HTTP errors were captured; review paths before treating them as generation failures.'
            ];
        }

        if (last) return ['Generation Impact: no generation-related HTTP errors captured.'];

        return ['Generation Impact: no complete generation captured yet.'];
    }

    function addHttpReport(lines) {
        lines.push('');
        lines.push('## HTTP Request Classification');
        lines.push('- Classifier: path/status only; request bodies, response bodies, headers, query strings, and API keys are not recorded.');

        const gen = generationHttpErrors();
        const bg = backgroundHttpErrors();
        const unk = unknownHttpErrors();
        const tests = testHttpErrors();

        if (!gen.length) {
            lines.push('- Generation HTTP Errors: none captured.');
        } else {
            lines.push('- Generation HTTP Errors:');
            for (const g of compactHttpGroups(gen).slice(-8)) {
                lines.push('  - ' + formatHttpGroup(g));
            }
        }

        if (!bg.length) {
            lines.push('- Background / Extension Notices: none captured.');
        } else {
            lines.push('- Background / Extension Notices:');
            for (const g of compactHttpGroups(bg).slice(-8)) {
                lines.push('  - ' + formatHttpGroup(g));
            }
        }

        if (unk.length) {
            lines.push('- Unknown HTTP Errors:');
            for (const g of compactHttpGroups(unk).slice(-5)) {
                lines.push('  - ' + formatHttpGroup(g));
            }
        }

        if (tests.length) {
            lines.push(`- Ignored Test Requests: ${tests.length}`);
        }
    }

    function buildReport(communityMode) {
        sanitizeGenerationState('report');
        const snap = getSnapshot();
        const health = linkHealth();
        const last = state.lastGeneration;
        const lines = [];

        lines.push('# SillyTavern Diagnostic Report');
        lines.push('');
        lines.push('Report Type: ' + (communityMode ? 'Community / Redacted' : 'Full Local'));
        lines.push('Plugin Version: ' + VERSION);
        lines.push('Generated at: ' + nowIso());

        lines.push('');
        lines.push('## Snapshot');
        lines.push('- Context Ready: ' + (snap.ready ? 'yes' : 'no'));
        lines.push('- API: ' + snap.api);
        lines.push('- Source: ' + snap.source);
        lines.push('- Model: ' + snap.model);

        if (communityMode) {
            lines.push('- Preset: [hidden]');
            lines.push('- Character: [hidden]');
            lines.push('- Chat ID: [hidden]');
        } else {
            lines.push('- Preset: ' + snap.preset);
            lines.push('- Character: ' + snap.character);
            lines.push('- Chat ID: ' + snap.chatId);
        }

        lines.push('- Messages: ' + snap.messages);
        lines.push('- Legacy Diagnostic Plugin Detected: ' + (snap.legacyDetected ? 'yes' : 'no'));

        lines.push('');
        lines.push('## Link Health');
        lines.push('- Status: ' + health.status);
        lines.push('- Reason: ' + health.reason);

        lines.push('');
        lines.push('## Generation Summary');
        lines.push('- ' + generationSummary());

        if (last) {
            lines.push('- Trigger Type: ' + (last.triggerType || 'unknown'));
            lines.push('- Started At: ' + last.startedAt);
            lines.push('- Ended At: ' + last.endedAt);
            lines.push('- Duration: ' + Math.round((last.durationMs || 0) / 1000) + ' sec');
            lines.push('- First Chunk Latency: ' + (
                last.firstTokenLatencyMs !== null && last.firstTokenLatencyMs !== undefined
                    ? Math.round(last.firstTokenLatencyMs / 1000) + ' sec'
                    : '(not captured)'
            ));
            lines.push('- Stream Chunks Observed: ' + last.streamTokens);
            lines.push('- Message Received: ' + (last.messageReceived ? 'yes' : 'no'));
            lines.push('- Stopped By User: ' + (last.stopped ? 'yes' : 'no'));
        } else {
            lines.push('- No complete generation captured yet.');
        }

        lines.push('');
        lines.push('## Risk Check');
        lines.push('- ' + riskText());

        lines.push('');
        lines.push('## Recent Generation Timeline');
        const recent = recentGenerationTimeline();
        if (recent.length) {
            for (const line of recent) lines.push('- ' + line);
        } else {
            lines.push('- No recent generation timeline captured.');
        }

        lines.push('');
        lines.push('## Generation Impact');
        for (const line of generationImpactLines()) lines.push('- ' + line);

        addHttpReport(lines);

        lines.push('');
        lines.push('## Session Timeline');
        const session = sessionTimeline();
        if (session.length) {
            for (const line of session.slice(-20)) lines.push('- ' + line);
        } else {
            lines.push('- No session events captured.');
        }

        lines.push('');
        lines.push('## Privacy');
        lines.push('- This report does not include chat content, prompts, API keys, request bodies, response bodies, headers, or query strings.');
        if (communityMode) lines.push('- Preset, character, and chat ID are hidden in this report.');

        return lines.join('\n');
    }

    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            alert('v0.4 clean 报告已复制');
        } catch {
            const t = document.createElement('textarea');
            t.value = text;
            t.style.position = 'fixed';
            t.style.left = '-9999px';
            document.body.appendChild(t);
            t.focus();
            t.select();

            try {
                document.execCommand('copy');
                alert('v0.4 clean 报告已复制');
            } catch {
                console.log('[STDH4C report]\n' + text);
                alert('复制失败，报告已输出到控制台');
            } finally {
                t.remove();
            }
        }
    }

    function esc(v) {
        return String(v)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    function row(k, v) {
        return `<div class="stdh4c-row"><span class="stdh4c-key">${esc(k)}</span><span class="stdh4c-val">${esc(String(v).slice(0, 110))}</span></div>`;
    }

    function mountUI() {
        if (document.getElementById('stdh4c-root')) return;

        const root = document.createElement('div');
        root.id = 'stdh4c-root';

        root.innerHTML = `
            <button id="stdh4c-toggle" type="button">诊断v4</button>
            <div id="stdh4c-panel">
                <div class="stdh4c-head">
                    <b>酒馆诊断助手 v0.4 Clean</b>
                    <button id="stdh4c-close" type="button">×</button>
                </div>

                <div id="stdh4c-health" class="stdh4c-box stdh4c-good"></div>

                <div class="stdh4c-section">
                    <div class="stdh4c-title">生成摘要</div>
                    <div id="stdh4c-gen" class="stdh4c-box"></div>
                    <div id="stdh4c-risk" class="stdh4c-box stdh4c-good"></div>
                </div>

                <div class="stdh4c-section">
                    <div class="stdh4c-title">HTTP 请求分类</div>
                    <div id="stdh4c-http" class="stdh4c-box stdh4c-warn"></div>
                    <div class="stdh4c-actions">
                        <button id="stdh4c-test-404" type="button">测试 404</button>
                        <button id="stdh4c-clear-http" type="button">清空 HTTP</button>
                    </div>
                    <pre id="stdh4c-http-list" class="stdh4c-pre"></pre>
                </div>

                <div class="stdh4c-actions">
                    <button id="stdh4c-copy-community" type="button">复制社区版</button>
                    <button id="stdh4c-copy-full" type="button">复制完整报告</button>
                </div>

                <div class="stdh4c-actions">
                    <button id="stdh4c-refresh" type="button">刷新</button>
                    <button id="stdh4c-reset-pos" type="button">重置位置</button>
                </div>

                <div class="stdh4c-actions">
                    <button id="stdh4c-mark-stop" type="button">标记手动停止</button>
                    <button id="stdh4c-clear-events" type="button">清空事件</button>
                </div>

                <div class="stdh4c-section">
                    <div class="stdh4c-title">基础快照</div>
                    <div id="stdh4c-snapshot"></div>
                </div>

                <div class="stdh4c-section">
                    <div class="stdh4c-title">最近生成时间线</div>
                    <pre id="stdh4c-recent" class="stdh4c-pre"></pre>
                </div>

                <div class="stdh4c-section">
                    <div class="stdh4c-title">会话事件</div>
                    <pre id="stdh4c-session" class="stdh4c-pre"></pre>
                </div>
            </div>
        `;

        document.body.appendChild(root);

        document.getElementById('stdh4c-toggle').onclick = () => {
            const p = document.getElementById('stdh4c-panel');
            p.style.display = p.style.display === 'block' ? 'none' : 'block';
            render();
        };

        document.getElementById('stdh4c-close').onclick = () => {
            document.getElementById('stdh4c-panel').style.display = 'none';
        };

        document.getElementById('stdh4c-copy-community').onclick = () => copyText(buildReport(true));
        document.getElementById('stdh4c-copy-full').onclick = () => copyText(buildReport(false));
        document.getElementById('stdh4c-refresh').onclick = () => addEvent('MANUAL_REFRESH');

        document.getElementById('stdh4c-reset-pos').onclick = () => {
            applyPosition(root, 12, 72);
            savePosition(12, 72);
            addEvent('POSITION_RESET');
        };

        document.getElementById('stdh4c-mark-stop').onclick = () => {
            markManualStop('manual override button');
            if (state.lastGeneration) {
                state.lastGeneration.stopped = true;
                state.lastGeneration.stoppedSource = 'manual override button';
            }
            alert('已将最近一次生成标记为：用户手动停止');
            render();
        };

        document.getElementById('stdh4c-clear-events').onclick = () => {
            state.events = [];
            state.currentGeneration = null;
            state.lastGeneration = null;
            addEvent('EVENTS_CLEARED');
        };

        document.getElementById('stdh4c-test-404').onclick = () => {
            fetch('/__stdh4c_test_404_' + Date.now()).catch(() => {});
        };

        document.getElementById('stdh4c-clear-http').onclick = () => {
            state.http.errors = [];
            render();
            alert('HTTP 记录已清空');
        };

        restorePosition();
        bindDrag();
        render();
    }

    function render() {
        sanitizeGenerationState('render');
        const healthEl = document.getElementById('stdh4c-health');
        if (!healthEl) return;

        const health = linkHealth();
        const snap = getSnapshot();

        healthEl.textContent = `Link Health: ${health.status}｜${health.reason}`;
        document.getElementById('stdh4c-gen').textContent = generationSummary();
        document.getElementById('stdh4c-risk').textContent = riskText();

        renderHttpUI();

        document.getElementById('stdh4c-snapshot').innerHTML = [
            row('Context', snap.ready ? 'ready' : 'waiting'),
            row('API', snap.api),
            row('Source', snap.source),
            row('Model', snap.model),
            row('Preset', snap.preset),
            row('Messages', snap.messages),
            row('Character', snap.character),
            row('Legacy Plugin', snap.legacyDetected ? 'detected' : 'not detected')
        ].join('');

        const recent = recentGenerationTimeline();
        document.getElementById('stdh4c-recent').textContent =
            recent.length ? recent.join('\n') : '暂无最近生成时间线。';

        const session = sessionTimeline();
        document.getElementById('stdh4c-session').textContent =
            session.length ? session.slice(-30).join('\n') : '暂无事件。';
    }

    function renderHttpUI() {
        const summary = document.getElementById('stdh4c-http');
        const list = document.getElementById('stdh4c-http-list');
        if (!summary || !list) return;

        if (state.http.disabledReason) {
            summary.textContent = state.http.disabledReason;
            list.textContent = '';
            return;
        }

        const gen = generationHttpErrors();
        const bg = backgroundHttpErrors();
        const unk = unknownHttpErrors();
        const tests = testHttpErrors();
        const real = realHttpErrors();

        if (gen.length) {
            summary.textContent = '生成相关错误：' + formatHttpGroup(compactHttpGroups(gen).slice(-1)[0]);
        } else if (bg.length) {
            summary.textContent = '后台/扩展提示：' + formatHttpGroup(compactHttpGroups(bg).slice(-1)[0]);
        } else if (unk.length) {
            summary.textContent = '未分类 HTTP 错误：' + formatHttpGroup(compactHttpGroups(unk).slice(-1)[0]);
        } else if (tests.length) {
            summary.textContent = `仅捕获测试请求 ${tests.length} 次，社区报告会忽略。`;
        } else {
            summary.textContent = '暂无生成相关 HTTP 错误或后台提示。';
        }

        const groups = compactHttpGroups(real);

        if (!groups.length) {
            list.textContent = tests.length ? `测试请求 × ${tests.length}，已从社区报告中过滤。` : '';
            return;
        }

        list.textContent = groups.slice(-12).map(formatHttpGroup).join('\n');
    }

    function clamp(v, min, max) {
        return Math.max(min, Math.min(max, v));
    }

    function savePosition(x, y) {
        try {
            localStorage.setItem(POS_KEY, JSON.stringify({ x, y }));
        } catch {}
    }

    function getSavedPosition() {
        try {
            const raw = localStorage.getItem(POS_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }

    function applyPosition(root, x, y) {
        const w = root.offsetWidth || 120;
        const h = root.offsetHeight || 60;
        const maxX = Math.max(0, window.innerWidth - w - 6);
        const maxY = Math.max(0, window.innerHeight - h - 6);
        const fx = clamp(x, 4, maxX);
        const fy = clamp(y, 4, maxY);

        root.style.left = fx + 'px';
        root.style.top = fy + 'px';
        root.style.right = 'auto';
        root.style.bottom = 'auto';

        return { x: fx, y: fy };
    }

    function restorePosition() {
        const root = document.getElementById('stdh4c-root');
        if (!root) return;

        const saved = getSavedPosition();

        if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
            applyPosition(root, saved.x, saved.y);
        } else {
            applyPosition(root, 12, 72);
        }
    }

    function bindDrag() {
        if (state.dragBound) return;

        const root = document.getElementById('stdh4c-root');
        const handle = document.getElementById('stdh4c-toggle');
        if (!root || !handle) return;

        let dragging = false;
        let moved = false;
        let sx = 0;
        let sy = 0;
        let bx = 0;
        let by = 0;

        handle.addEventListener('pointerdown', e => {
            if (e.button !== undefined && e.button !== 0) return;

            const rect = root.getBoundingClientRect();
            dragging = true;
            moved = false;
            sx = e.clientX;
            sy = e.clientY;
            bx = rect.left;
            by = rect.top;
            root.classList.add('stdh4c-dragging');

            try {
                handle.setPointerCapture(e.pointerId);
            } catch {}
        }, { passive: false });

        handle.addEventListener('pointermove', e => {
            if (!dragging) return;

            const dx = e.clientX - sx;
            const dy = e.clientY - sy;

            if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;

            const pos = applyPosition(root, bx + dx, by + dy);
            savePosition(pos.x, pos.y);
            e.preventDefault();
        }, { passive: false });

        function up() {
            if (!dragging) return;
            dragging = false;
            root.classList.remove('stdh4c-dragging');

            if (moved) {
                root.dataset.justDragged = '1';
                setTimeout(() => root.dataset.justDragged = '0', 250);
            }
        }

        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);

        handle.addEventListener('click', e => {
            if (root.dataset.justDragged === '1') {
                e.preventDefault();
                e.stopImmediatePropagation();
                root.dataset.justDragged = '0';
            }
        }, true);

        state.dragBound = true;
        addEvent('DRAG_BOUND');
    }

    function boot() {
        mountUI();
        addEvent('PLUGIN_IMPORTED');

        let tries = 0;

        const timer = setInterval(() => {
            tries += 1;
            bindEvents();
            bindStopDom();
            installHttpMonitor();

            if (
                state.eventBound &&
                state.stopDomBound &&
                (state.http.bound || state.http.disabledReason || tries >= 80)
            ) {
                clearInterval(timer);
            }
        }, 800);

        setInterval(() => {
            sanitizeGenerationState('watchdog');
            mountUI();
            render();
        }, 1200);

        console.log(LOG_PREFIX + ' imported ' + VERSION);
    }

    globalThis.STDH4Clean = {
        version: VERSION,
        state,
        getSnapshot,
        buildReport,
        render,
        linkHealth,
        generationSummary,
        riskText,
        realHttpErrors,
        testHttpErrors
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
