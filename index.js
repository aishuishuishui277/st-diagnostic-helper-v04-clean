(function () {
    'use strict';

    const VERSION = '0.4.24-mini-priority';
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

    function joinDiagnosis(title, meaning, likelyCause, action) {
        return `${title}｜含义：${meaning}｜常见原因：${likelyCause}｜建议：${action}`;
    }

    function explainHttp(item) {
        const status = item.status;
        const category = item.category || classifyHttp(item);
        const path = normalizePath(item);

        if (category === 'background') {
            if (path.startsWith('/api/extensions/version')) {
                return joinDiagnosis(
                    '后台扩展版本检查失败',
                    'SillyTavern 正在检查扩展版本，但该后台请求失败。',
                    'GitHub 访问失败、扩展仓库不可达、网络/TLS 中断、代理不稳定。',
                    '若生成本身正常，可忽略；需要更新插件时再检查 GitHub 网络或稍后重试。'
                );
            }

            return joinDiagnosis(
                '后台接口错误',
                '错误来自设置、扩展、资源或本地后台接口，不一定属于模型生成链路。',
                '扩展刷新、资源加载、设置保存、本地服务状态异常。',
                '先看生成是否成功；若只影响后台功能，优先检查相关扩展或本地服务。'
            );
        }

        if (category === 'test') {
            return '插件测试请求，可忽略。';
        }

        if (status === 'NETWORK_ERROR') {
            return joinDiagnosis(
                'NETWORK_ERROR',
                '浏览器 fetch 没拿到有效 HTTP 响应。',
                '网络断开、连接重置、CORS、本地后端不可达、代理链路中断、TLS/证书问题。',
                '先检查节点/代理、SillyTavern 后端是否还在运行、接口地址是否可达；不要直接归因于模型。'
            );
        }

        const table = {
            400: [
                '400 Bad Request',
                '请求格式错误，服务器无法按当前参数处理。',
                '请求参数、模型名、预设格式、消息格式、反代兼容层不匹配。',
                '检查模型名、API 格式、预设、上下文长度和请求端兼容性。'
            ],
            401: [
                '401 Unauthorized',
                '鉴权失败或缺少有效认证。',
                'API key 错误、secret 失效、登录状态失效、鉴权头没有被后端接受。',
                '检查 API key / secret / 登录状态；不要公开完整密钥。'
            ],
            403: [
                '403 Forbidden',
                '服务器理解请求，但拒绝处理。',
                '模型权限不足、账号/地区/IP 被策略拒绝、公益站或第三方平台规则限制、请求端不合规。',
                '检查模型权限、账号状态、服务商规则和请求来源；不要盲目高频重试。'
            ],
            404: [
                '404 Not Found',
                '请求路径、模型路由或资源不存在。',
                '接口地址写错、模型名不存在、反代路由不存在、后端路径不匹配。',
                '检查 base URL、模型名、endpoint 路由和反代配置。'
            ],
            408: [
                '408 Request Timeout',
                '服务器等待请求超时。',
                '网络慢、请求发送不完整、代理链路卡住、移动网络波动。',
                '检查网络稳定性，降低上下文/附件体积，必要时重试。'
            ],
            409: [
                '409 Conflict',
                '请求与当前服务状态冲突。',
                '并发请求、会话状态冲突、后端任务还未完成、重复提交。',
                '等当前任务结束后再试，避免多开或连续点生成。'
            ],
            413: [
                '413 Payload Too Large',
                '请求体过大。',
                '上下文过长、图片/附件过大、世界书/预设堆叠过多、反代限制较小。',
                '降低上下文长度、减少附件、压缩图片、精简世界书或预设。'
            ],
            422: [
                '422 Unprocessable Content',
                '请求格式能解析，但语义或参数不被接受。',
                '参数组合非法、模型不支持某些字段、工具/函数调用格式不兼容。',
                '检查预设参数、工具调用、temperature/top_p 等字段兼容性。'
            ],
            429: [
                '429 Too Many Requests',
                '请求过多，被服务端限流。',
                'RPM/TPM 超限、并发过高、公益站额度限制、IP/账号频率限制、重复重试太快。',
                '降低并发和重试频率，等待配额恢复；公益站场景先看额度和规则。'
            ],
            500: [
                '500 Internal Server Error',
                '服务端内部错误。',
                '上游模型服务、反代后端、兼容层或本地服务内部异常。',
                '保留脱敏报告给服务端维护者；若偶发可稍后重试。'
            ],
            502: [
                '502 Bad Gateway',
                '网关或代理从上游收到无效响应。',
                '反代到上游失败、上游返回异常、网关/兼容层处理失败。',
                '检查反代日志、上游可用性、节点链路；通常不是前端 UI 问题。'
            ],
            503: [
                '503 Service Unavailable',
                '服务暂时不可用。',
                '服务维护、后端过载、队列爆满、公益站容量不足、上游临时不可用。',
                '稍后再试，降低并发；公益站场景优先查看公告或状态页。'
            ],
            504: [
                '504 Gateway Timeout',
                '网关或代理等待上游响应超时。',
                '长文本生成过慢、上游卡住、反代等待超时、代理链路慢。',
                '减少上下文长度，换较快模型/线路；若频繁出现需检查反代超时设置。'
            ],
            520: [
                '520 Cloudflare Unknown Error',
                'Cloudflare 收到源站空响应、未知响应或异常响应。',
                '源站程序异常、反代返回非标准响应、源站连接被中断。',
                '检查源站/反代日志；用户侧可尝试换节点或稍后重试。'
            ],
            521: [
                '521 Cloudflare Web Server Down',
                'Cloudflare 连接源站被拒绝。',
                '源站服务离线、防火墙阻止 Cloudflare、源站端口未监听。',
                '维护者应检查源站服务和防火墙；普通用户只能反馈给站点方。'
            ],
            522: [
                '522 Cloudflare Connection Timed Out',
                'Cloudflare 连接源站超时。',
                '源站网络不可达、防火墙丢包、服务器压力大、路由问题。',
                '检查源站连通性、防火墙和服务器压力；用户侧可稍后重试。'
            ],
            523: [
                '523 Cloudflare Origin Is Unreachable',
                'Cloudflare 无法到达源站。',
                'DNS 指向错误、源站 IP 不可达、路由或网络故障。',
                '维护者检查 DNS/源站 IP/路由；用户侧可反馈给站点方。'
            ],
            524: [
                '524 Cloudflare Timeout',
                'Cloudflare 已连接源站，但源站在超时时间内没有返回 HTTP 响应。',
                '上游生成太慢、长文本请求过重、反代后端卡死、源站压力大。',
                '减少上下文长度，换轻量模型；维护者应检查源站耗时、队列和超时设置。'
            ]
        };

        if (table[status]) {
            return joinDiagnosis(...table[status]);
        }

        if (typeof status === 'number' && status >= 400 && status < 500) {
            return joinDiagnosis(
                `${status} Client Error`,
                '请求被服务端按客户端错误处理。',
                '参数、权限、路径、账号状态、请求频率或兼容性问题。',
                '优先检查配置、模型名、权限和请求格式。'
            );
        }

        if (typeof status === 'number' && status >= 500) {
            return joinDiagnosis(
                `${status} Server Error`,
                '服务端、网关、反代或上游发生错误。',
                '上游服务异常、反代故障、源站超时、服务器过载。',
                '保留脱敏报告，检查服务端/反代日志；用户侧可稍后重试或换线路。'
            );
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
            target: safeTarget(info.url || ''),
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

    
    // removed duplicate core dead function by v0.4.17

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


    
    // removed duplicate core dead function by v0.4.17


    // removed duplicate core dead function by v0.4.17

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

    
    // removed duplicate core dead function by v0.4.17

// removed duplicate token-lens dead function by v0.4.16

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
        fixStopFalsePositiveV0420('buildReport');
        sanitizeGenerationState('report');
        const snap = getSnapshot();
        const health = linkHealth();
        const latestAttemptForReport = state.lastGeneration;
        const last = preferredGenerationForReport();
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

        addLatestAttemptReport(lines);

        addLastSuccessReport(lines);

        addTokenLensReport(lines);

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

        document.getElementById('stdh4c-copy-community').onclick = () => copyText(buildCommunityReport());
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
        fixStopFalsePositiveV0420('render');
        sanitizeGenerationState('render');
        const healthEl = document.getElementById('stdh4c-health');
        if (!healthEl) return;

        const health = linkHealth();
        const snap = getSnapshot();

        healthEl.textContent = `Link Health: ${health.status}｜${health.reason}`;
        document.getElementById('stdh4c-gen').textContent = generationSummary();
        document.getElementById('stdh4c-risk').textContent = riskText();

        renderHttpUI();
        renderTokenLensUI();

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


    // STDH4C_HTTP_SIM_TEST_V042
    function simulateHttpError(status, kind) {
        const finalKind = kind || 'generation';

        let url = '/api/backends/stdh4c-simulated/generate';
        let method = 'POST';

        if (finalKind === 'background') {
            url = '/api/extensions/version';
            method = 'POST';
        }

        if (finalKind === 'unknown') {
            url = '/__stdh4c_simulated_unknown';
            method = 'GET';
        }

        const finalStatus = status === 'NETWORK_ERROR'
            ? 'NETWORK_ERROR'
            : Number(status);

        recordHttpError({
            status: finalStatus,
            method,
            url,
            durationMs: finalStatus === 524 ? 100000 : 4321
        });

        addEvent('SIMULATED_HTTP_' + finalStatus, finalKind);
        render();
    }

    function mountHttpSimPanel() {
        if (document.getElementById('stdh4c-http-sim')) return;

        const panel = document.getElementById('stdh4c-panel');
        if (!panel) return;

        const box = document.createElement('div');
        box.id = 'stdh4c-http-sim';
        box.className = 'stdh4c-section';

        box.innerHTML = `
            <div class="stdh4c-title">HTTP 状态码模拟测试</div>
            <div class="stdh4c-note">
                仅用于本地测试解释文本，不发送真实 API 请求。测完请点“清空 HTTP”。
            </div>
            <div class="stdh4c-actions">
                <button id="stdh4c-sim-403" type="button">模拟 403</button>
                <button id="stdh4c-sim-429" type="button">模拟 429</button>
            </div>
            <div class="stdh4c-actions">
                <button id="stdh4c-sim-503" type="button">模拟 503</button>
                <button id="stdh4c-sim-524" type="button">模拟 524</button>
            </div>
            <div class="stdh4c-actions">
                <button id="stdh4c-sim-net" type="button">模拟 NETWORK</button>
                <button id="stdh4c-sim-bg" type="button">模拟后台失败</button>
            </div>
        `;

        panel.appendChild(box);

        document.getElementById('stdh4c-sim-403').onclick = () => simulateHttpError(403, 'generation');
        document.getElementById('stdh4c-sim-429').onclick = () => simulateHttpError(429, 'generation');
        document.getElementById('stdh4c-sim-503').onclick = () => simulateHttpError(503, 'generation');
        document.getElementById('stdh4c-sim-524').onclick = () => simulateHttpError(524, 'generation');
        document.getElementById('stdh4c-sim-net').onclick = () => simulateHttpError('NETWORK_ERROR', 'generation');
        document.getElementById('stdh4c-sim-bg').onclick = () => simulateHttpError('NETWORK_ERROR', 'background');
    }



    // STDH4C_TOKEN_LENS_V043
    function textOnly(value) {
        if (value === null || value === undefined) return '';
        if (typeof value === 'string') return value;
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        if (Array.isArray(value)) return value.map(textOnly).filter(Boolean).join('\n');

        if (typeof value === 'object') {
            const keys = [
                'mes',
                'message',
                'content',
                'text',
                'description',
                'personality',
                'scenario',
                'first_mes',
                'mes_example',
                'system_prompt',
                'post_history_instructions'
            ];

            return keys.map(key => textOnly(value[key])).filter(Boolean).join('\n');
        }

        return '';
    }

    function countTokensSafe(text) {
        const str = String(text || '');
        const ctx = getCtx();

        if (!str) return { tokens: 0, chars: 0, mode: 'empty' };

        try {
            if (ctx && typeof ctx.getTokenCount === 'function') {
                const n = ctx.getTokenCount(str);
                if (typeof n === 'number' && Number.isFinite(n)) {
                    return { tokens: Math.max(0, Math.round(n)), chars: str.length, mode: 'exact' };
                }
            }
        } catch {}

        return { tokens: Math.ceil(str.length / 3.5), chars: str.length, mode: 'estimated' };
    }

    function sumTexts(list) {
        let tokens = 0;
        let chars = 0;
        let exact = 0;
        let estimated = 0;

        for (const text of list || []) {
            const c = countTokensSafe(text);
            tokens += c.tokens || 0;
            chars += c.chars || 0;
            if (c.mode === 'exact') exact += 1;
            if (c.mode === 'estimated') estimated += 1;
        }

        let mode = 'empty';
        if (exact > 0 && estimated === 0) mode = 'exact';
        else if (exact > 0 && estimated > 0) mode = 'mixed';
        else if (estimated > 0) mode = 'estimated';

        return { tokens, chars, mode };
    }

    function currentCharacter() {
        const ctx = getCtx();
        const id = ctx?.characterId;

        if (Number.isInteger(id) && Array.isArray(ctx?.characters)) {
            return ctx.characters[id] || null;
        }

        return null;
    }

    function characterTexts() {
        const ch = currentCharacter();
        if (!ch) return [];

        const data = ch.data || ch;
        const keys = [
            'description',
            'personality',
            'scenario',
            'first_mes',
            'mes_example',
            'system_prompt',
            'post_history_instructions'
        ];

        return keys
            .map(key => textOnly(data[key] ?? ch[key]))
            .filter(Boolean);
    }

    function messageText(msg) {
        return textOnly(msg?.mes ?? msg?.message ?? msg?.content ?? msg?.text ?? '');
    }

    function chatTexts() {
        const ctx = getCtx();
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
        return chat.map(messageText).filter(Boolean);
    }

    function isUserMessage(msg) {
        return Boolean(msg?.is_user || msg?.role === 'user' || msg?.sender === 'user');
    }

    function isAssistantMessage(msg) {
        if (!msg || msg.is_user || msg.is_system) return false;
        return Boolean(msg.role === 'assistant' || msg.role === 'model' || msg.name || msg.mes);
    }

    function lastMessageTokens(kind) {
        const ctx = getCtx();
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];

        for (let i = chat.length - 1; i >= 0; i -= 1) {
            const msg = chat[i];

            if (kind === 'user' && !isUserMessage(msg)) continue;
            if (kind === 'assistant' && !isAssistantMessage(msg)) continue;

            const text = messageText(msg);
            if (text) return countTokensSafe(text);
        }

        return { tokens: 0, chars: 0, mode: 'empty' };
    }

    function personaTexts() {
        const ctx = getCtx();

        return [
            ctx?.persona_description,
            ctx?.power_user?.persona_description,
            ctx?.powerUser?.persona_description,
            ctx?.extensionSettings?.persona_description,
            ctx?.chatMetadata?.persona_description
        ].map(textOnly).filter(Boolean);
    }

    function firstPositiveNumber(list) {
        for (const value of list || []) {
            const n = Number(value);
            if (Number.isFinite(n) && n > 0) return Math.round(n);
        }
        return 0;
    }

    function contextWindowSafe() {
        const ctx = getCtx();

        return firstPositiveNumber([
            ctx?.max_context,
            ctx?.maxContext,
            ctx?.context_size,
            ctx?.chatCompletionSettings?.openai_max_context,
            ctx?.chatCompletionSettings?.max_context,
            ctx?.chatCompletionSettings?.context_size,
            ctx?.textCompletionSettings?.max_context,
            ctx?.textCompletionSettings?.context_size,
            ctx?.power_user?.max_context,
            ctx?.powerUser?.max_context
        ]);
    }

    function maxResponseSafe() {
        const ctx = getCtx();

        return firstPositiveNumber([
            ctx?.amount_gen,
            ctx?.max_response_length,
            ctx?.chatCompletionSettings?.openai_max_tokens,
            ctx?.chatCompletionSettings?.max_tokens,
            ctx?.textCompletionSettings?.amount_gen,
            ctx?.textCompletionSettings?.max_new_tokens,
            ctx?.power_user?.amount_gen,
            ctx?.powerUser?.amount_gen
        ]);
    }

    function tokenRiskLevel(tokens, contextWindow, maxResponse) {
        if (!contextWindow) return 'Unknown';

        const usable = Math.max(1, contextWindow - (maxResponse || 0));
        const ratio = tokens / usable;

        if (tokens > usable) return 'Critical';
        if (ratio >= 0.9) return 'High';
        if (ratio >= 0.7) return 'Medium';

        return 'Low';
    }

    function worldInfoEventCount() {
        return state.events.filter(event => String(event.name || '').includes('WORLDINFO')).length;
    }

    
    // removed duplicate token-lens dead function by v0.4.16

// STDH4C_TOKEN_LENS_UI_V043
    function mountTokenLensPanel() {
        if (document.getElementById('stdh4c-token-lens')) return;

        const panel = document.getElementById('stdh4c-panel');
        if (!panel) return;

        const box = document.createElement('div');
        box.id = 'stdh4c-token-lens';
        box.className = 'stdh4c-section';

        box.innerHTML = `
            <div class="stdh4c-title">提示词数量诊断 / Prompt Token Lens</div>
            <div id="stdh4c-token-summary" class="stdh4c-box stdh4c-good"></div>
            <div id="stdh4c-token-detail"></div>
            <div class="stdh4c-note">只显示 token / 字符数量，不显示 prompt 正文。</div>
        `;

        const httpSection = document.getElementById('stdh4c-http')?.closest('.stdh4c-section');

        if (httpSection && httpSection.parentElement) {
            httpSection.parentElement.insertBefore(box, httpSection);
        } else {
            panel.appendChild(box);
        }

        renderTokenLensUI();
    }

    
    // removed duplicate token-lens dead function by v0.4.16

// STDH4C_V044_TOKEN_LENS_FIX
    function isGoodGeneration(gen) {
        return Boolean(
            gen &&
            gen.messageReceived &&
            !gen.stopped &&
            (
                (gen.streamTokens || 0) > 0 ||
                gen.firstStreamAt ||
                gen.firstTokenLatencyMs !== null
            )
        );
    }

    function rememberGoodGeneration() {
        if (isGoodGeneration(state.lastGeneration)) {
            state.lastGoodGeneration = { ...state.lastGeneration };
        }
    }

    function addLastSuccessReport(lines) {
        rememberGoodGeneration();

        const latest = state.lastGeneration;
        const good = state.lastGoodGeneration;

        if (!good) return;

        if (latest && latest.id === good.id) return;

        lines.push('');
        lines.push('## Last Successful Generation');
        lines.push('- This section keeps the latest successful generation when the newest attempt failed or was interrupted.');
        lines.push('- Started At: ' + good.startedAt);
        lines.push('- Ended At: ' + good.endedAt);
        lines.push('- Duration: ' + Math.round((good.durationMs || 0) / 1000) + ' sec');
        lines.push('- First Chunk Latency: ' + (
            good.firstTokenLatencyMs !== null && good.firstTokenLatencyMs !== undefined
                ? Math.round(good.firstTokenLatencyMs / 1000) + ' sec'
                : '(not captured)'
        ));
        lines.push('- Stream Chunks Observed: ' + (good.streamTokens || 0));
        lines.push('- Message Received: ' + (good.messageReceived ? 'yes' : 'no'));
        lines.push('- Stopped By User: ' + (good.stopped ? 'yes' : 'no'));
    }

    function promptViewerTotalTokensFromDom() {
        try {
            const text = document.body?.innerText || '';

            const patterns = [
                /总\s*token\s*数\s*[:：]?\s*([\d,]+)/i,
                /总token数\s*[:：]?\s*([\d,]+)/i,
                /Total\s*tokens?\s*[:：]?\s*([\d,]+)/i
            ];

            for (const pattern of patterns) {
                const match = text.match(pattern);

                if (match && match[1]) {
                    const n = Number(String(match[1]).replace(/,/g, ''));
                    if (Number.isFinite(n) && n > 0) return Math.round(n);
                }
            }
        } catch {}

        return 0;
    }

    function contextLooksReliable(contextWindow, maxResponse, bestTokens) {
        if (!contextWindow) return false;

        if (maxResponse && maxResponse >= contextWindow) return false;

        if (contextWindow <= 8192 && bestTokens > contextWindow * 1.5) {
            return false;
        }

        return true;
    }

    
    // removed duplicate token-lens dead function by v0.4.16


    // removed duplicate token-lens dead function by v0.4.16


    // removed duplicate token-lens dead function by v0.4.16

// STDH4C_V045_ITEMIZED_PROMPT_LENS
    function nnum(value) {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
    }

    function sumNums(values) {
        return values.reduce((a, b) => a + nnum(b), 0);
    }

    function getLatestPromptItem(arr) {
        if (!Array.isArray(arr) || arr.length === 0) return { item: null, index: -1 };

        const ctx = getCtx();
        const chatLen = Array.isArray(ctx?.chat) ? ctx.chat.length : 0;
        let bestIndex = -1;

        for (let i = 0; i < arr.length; i += 1) {
            const mesId = Number(arr[i]?.mesId);

            if (Number.isFinite(mesId) && chatLen && mesId <= chatLen - 1) {
                bestIndex = i;
            }
        }

        if (bestIndex < 0) bestIndex = arr.length - 1;

        return { item: arr[bestIndex], index: bestIndex };
    }

    function promptRiskFromLimit(total, limit) {
        if (!limit) return 'Unknown';

        const ratio = total / Math.max(1, limit);

        if (total > limit) return 'Critical';
        if (ratio >= 0.9) return 'High';
        if (ratio >= 0.7) return 'Medium';

        return 'Low';
    }

    function hasManualStopHintFor(gen) {
        if (!gen) return false;

        return state.events.some(event =>
            event.name === 'MANUAL_STOP_HINT' &&
            event.generationId === gen.id
        );
    }

    function normalizeStopState(source) {
        const last = state.lastGeneration;
        if (!last) return;

        const hasGenHttpError = generationHttpErrors().length > 0;

        if (last.stopped && hasGenHttpError && !hasManualStopHintFor(last)) {
            last.stopped = false;
            last.errorAborted = true;

            if (!last.stopReclassifiedLogged) {
                last.stopReclassifiedLogged = true;
                addEvent('STOP_RECLASSIFIED_ERROR_ABORT', source || 'normalize', last.id);
            }
        }

        if (isGoodGeneration(last)) {
            state.lastGoodGeneration = { ...last };
        }
    }

    async function refreshItemizedLensCache() {
        if (state.itemizedLensLoading) return;

        state.itemizedLensLoading = true;

        try {
            const mod = await import('/scripts/itemized-prompts.js');
            const arr = mod?.itemizedPrompts;

            if (!Array.isArray(arr) || arr.length === 0) {
                state.itemizedLensCache = {
                    available: false,
                    reason: 'Prompt Itemization data not available yet.'
                };
                return;
            }

            const picked = getLatestPromptItem(arr);
            const item = picked.item;
            const index = picked.index;

            if (!item || index < 0) {
                state.itemizedLensCache = {
                    available: false,
                    reason: 'No matching itemized prompt found.'
                };
                return;
            }

            let params = {};

            if (typeof mod.itemizedParams === 'function') {
                const mesId = nnum(item.mesId);
                params = await mod.itemizedParams(arr, index, mesId);
            }

            const total =
                nnum(params.finalPromptTokens) ||
                nnum(params.totalTokensInPrompt) ||
                nnum(item.oaiTotalTokens) ||
                nnum(item.finalPromptTokens);

            const chatTokens =
                nnum(params.ActualChatHistoryTokens) ||
                nnum(item.oaiConversationTokens);

            const characterTokens = sumNums([
                params.charDescriptionTokens,
                params.charPersonalityTokens,
                params.scenarioTextTokens
            ]);

            const worldInfoTokens = nnum(params.worldInfoStringTokens);

            const examplesTokens =
                nnum(params.examplesStringTokens) ||
                nnum(item.oaiExamplesTokens);

            const systemTokens =
                nnum(params.oaiSystemTokens) ||
                sumNums([
                    item.oaiStartTokens,
                    item.oaiMainTokens,
                    item.oaiNsfwTokens,
                    item.oaiBiasTokens,
                    item.oaiImpersonateTokens,
                    item.oaiJailbreakTokens,
                    item.oaiNudgeTokens
                ]);

            const anchorTokens = sumNums([
                params.allAnchorsTokens,
                params.beforeScenarioAnchorTokens,
                params.afterScenarioAnchorTokens,
                params.zeroDepthAnchorTokens
            ]);

            const promptLimit =
                nnum(params.thisPrompt_actual) ||
                nnum(params.thisPrompt_max_context) ||
                nnum(item.this_max_context);

            state.itemizedLensCache = {
                available: true,
                updatedAt: Date.now(),
                mesId: item.mesId,
                mode: 'sillytavern-itemized-prompts',
                total,
                promptLimit,
                chatTokens,
                characterTokens,
                worldInfoTokens,
                examplesTokens,
                systemTokens,
                anchorTokens,
                tokenizer: params.selectedTokenizer || item.tokenizer || '(unknown)',
                presetName: params.presetName || item.presetName || '(hidden)',
                messagesCount: params.messagesCount || item.messagesCount || '',
                examplesCount: params.examplesCount || item.examplesCount || ''
            };
        } catch (error) {
            state.itemizedLensCache = {
                available: false,
                reason: String(error?.message || error)
            };
        } finally {
            state.itemizedLensLoading = false;
        }
    }

    
    // removed duplicate token-lens dead function by v0.4.16


    // removed duplicate core dead function by v0.4.17

// removed duplicate token-lens dead function by v0.4.16


    // removed duplicate token-lens dead function by v0.4.16

// STDH4C_V046_REPORT_AND_TOKEN_FIX
    function latestAttemptIsHardError() {
        const last = state.lastGeneration;

        if (!last) return false;

        const hasHttpError = generationHttpErrors().length > 0;

        return Boolean(
            last.errorAborted ||
            (
                hasHttpError &&
                !last.messageReceived &&
                (last.streamTokens || 0) === 0
            )
        );
    }

    function preferredGenerationForReport() {
        normalizeStopState('preferred-generation');

        if (latestAttemptIsHardError() && state.lastGoodGeneration) {
            return state.lastGoodGeneration;
        }

        return state.lastGeneration;
    }

    function addLatestAttemptReport(lines) {
        const latest = state.lastGeneration;
        const preferred = preferredGenerationForReport();

        if (!latest || !preferred || latest.id === preferred.id) return;

        lines.push('');
        lines.push('## Latest Failed / Interrupted Attempt');
        lines.push('- This section shows the newest failed attempt separately so it does not overwrite the latest successful generation.');
        lines.push('- Started At: ' + latest.startedAt);
        lines.push('- Ended At: ' + latest.endedAt);
        lines.push('- Duration: ' + Math.round((latest.durationMs || 0) / 1000) + ' sec');
        lines.push('- First Chunk Latency: ' + (
            latest.firstTokenLatencyMs !== null && latest.firstTokenLatencyMs !== undefined
                ? Math.round(latest.firstTokenLatencyMs / 1000) + ' sec'
                : '(not captured)'
        ));
        lines.push('- Stream Chunks Observed: ' + (latest.streamTokens || 0));
        lines.push('- Message Received: ' + (latest.messageReceived ? 'yes' : 'no'));
        lines.push('- Stopped By User: ' + (latest.stopped ? 'yes' : 'no'));
        lines.push('- Error Aborted: ' + (latest.errorAborted ? 'yes' : 'no'));
    }


    // STDH4C_STOP_FALSE_POSITIVE_FIX_V0420
    function generationHasManualStopHintV0420(gen) {
        if (!gen || !gen.id) return false;

        try {
            return (state.events || []).some(event =>
                event &&
                event.generationId === gen.id &&
                event.name === 'MANUAL_STOP_HINT'
            );
        } catch {
            return false;
        }
    }

    function generationLooksCompletedV0420(gen) {
        if (!gen) return false;

        return Boolean(
            gen.messageReceived &&
            Number(gen.streamTokens || 0) > 0 &&
            gen.endedAt
        );
    }

    function fixStopFalsePositiveOneV0420(gen, reason) {
        if (!gen || !gen.stopped) return false;

        const hasManualHint = generationHasManualStopHintV0420(gen);

        if (hasManualHint) {
            return false;
        }

        if (!generationLooksCompletedV0420(gen)) {
            return false;
        }

        gen.stopped = false;
        gen.stopReason = 'normal_completed_reclassified';
        gen.stopFalsePositiveFixed = true;

        try {
            addEvent('STOP_FALSE_POSITIVE_FIXED', reason || 'unknown');
        } catch {
            // ignore
        }

        return true;
    }

    function fixStopFalsePositiveV0420(reason) {
        try {
            fixStopFalsePositiveOneV0420(state.lastGeneration, reason);
            fixStopFalsePositiveOneV0420(state.lastSuccessfulGeneration, reason);
        } catch {
            // ignore
        }
    }


    function generationSummary() {
        fixStopFalsePositiveV0420('generationSummary');
        normalizeStopState('generation-summary-v046');

        const cur = state.currentGeneration;
        const latest = state.lastGeneration;
        const preferred = preferredGenerationForReport();

        if (cur) {
            const sec = Math.round((Date.now() - new Date(cur.startedAt).getTime()) / 1000);
            return `正在生成：已耗时 ${sec} 秒；已捕获 ${cur.streamTokens || 0} 次 chunk/token。`;
        }

        if (!preferred) return '最近生成：尚未捕获完整生成。';

        const parts = [];

        if (latest && preferred.id !== latest.id) {
            parts.push('最近成功生成：已结束');
        } else {
            parts.push('最近生成：已结束');
        }

        parts.push(`耗时 ${Math.round((preferred.durationMs || 0) / 1000)} 秒`);

        if (preferred.firstTokenLatencyMs !== null && preferred.firstTokenLatencyMs !== undefined) {
            parts.push(`首 chunk 延迟 ${Math.round(preferred.firstTokenLatencyMs / 1000)} 秒`);
        } else {
            parts.push('未捕获首 chunk 延迟');
        }

        parts.push(`已捕获 ${preferred.streamTokens || 0} 次 chunk/token`);
        parts.push(`触发类型：${preferred.triggerType || 'unknown'}`);

        if (preferred.stopped) {
            parts.push('停止状态：用户手动停止');
        } else {
            parts.push('停止状态：正常结束');
        }

        if (latest && preferred.id !== latest.id) {
            parts.push('最新尝试：错误中断，已单独列出');
        }

        return parts.join('；');
    }

    function promptViewerDomTotalTokensV046() {
        try {
            const candidates = [];

            const bodyText = document.body?.innerText || '';
            if (bodyText) candidates.push(bodyText.slice(0, 5000));

            const nodes = Array.from(document.querySelectorAll('body *'));

            for (const node of nodes.slice(0, 1500)) {
                const text = node?.textContent || '';

                if (!text) continue;
                if (!/token|tokens|总/i.test(text)) continue;

                candidates.push(text.slice(0, 300));
            }

            const patterns = [
                /总\s*token\s*数\s*[:：]?\s*([0-9][0-9,\s]*)/i,
                /总token数\s*[:：]?\s*([0-9][0-9,\s]*)/i,
                /total\s*tokens?\s*[:：]?\s*([0-9][0-9,\s]*)/i,
                /Tokens?\s*[:：]\s*([0-9][0-9,\s]*)/i
            ];

            let best = 0;

            for (const text of candidates) {
                for (const pattern of patterns) {
                    const match = text.match(pattern);

                    if (!match || !match[1]) continue;

                    const n = Number(String(match[1]).replace(/[^\d]/g, ''));

                    if (Number.isFinite(n) && n > best) {
                        best = Math.round(n);
                    }
                }
            }

            return best;
        } catch {
            return 0;
        }
    }

    
    // removed duplicate token-lens dead function by v0.4.16


    // removed duplicate token-lens dead function by v0.4.16


    // removed duplicate token-lens dead function by v0.4.16

// STDH4C_V047_PROMPT_VIEWER_TOTAL_FIX
    function parsePromptTotalNumber(value) {
        const n = Number(String(value || '').replace(/[^\d]/g, ''));
        return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
    }

    function extractPromptTotalFromTextBlock(text) {
        const raw = String(text || '');
        if (!raw) return 0;

        const lines = raw
            .split(/\n+/)
            .map(x => x.trim())
            .filter(Boolean);

        let best = 0;

        const patterns = [
            /总\s*token\s*数\s*[:：]?\s*([0-9][0-9,\s]{0,12})/i,
            /总token数\s*[:：]?\s*([0-9][0-9,\s]{0,12})/i,
            /total\s*tokens?\s*[:：]?\s*([0-9][0-9,\s]{0,12})/i,
            /tokens?\s*total\s*[:：]?\s*([0-9][0-9,\s]{0,12})/i
        ];

        for (let i = 0; i < lines.length; i += 1) {
            const candidates = [
                lines[i],
                `${lines[i]} ${lines[i + 1] || ''}`
            ];

            for (const line of candidates) {
                for (const pattern of patterns) {
                    const m = line.match(pattern);
                    if (!m || !m[1]) continue;

                    const n = parsePromptTotalNumber(m[1]);

                    if (n > best && n >= 100) {
                        best = n;
                    }
                }
            }
        }

        return best;
    }

    function getSameOriginDocuments() {
        const docs = [document];

        try {
            for (const frame of Array.from(document.querySelectorAll('iframe'))) {
                try {
                    if (frame.contentDocument?.body) {
                        docs.push(frame.contentDocument);
                    }
                } catch {}
            }
        } catch {}

        return docs;
    }

    function promptViewerDomTotalTokensV047() {
        let best = 0;

        try {
            for (const doc of getSameOriginDocuments()) {
                const body = doc.body;
                if (!body) continue;

                best = Math.max(best, extractPromptTotalFromTextBlock(body.innerText || ''));

                const walker = doc.createTreeWalker(
                    body,
                    NodeFilter.SHOW_ELEMENT,
                    {
                        acceptNode(node) {
                            const text = node?.textContent || '';
                            if (!text) return NodeFilter.FILTER_SKIP;
                            if (!/总|token|tokens/i.test(text)) return NodeFilter.FILTER_SKIP;
                            return NodeFilter.FILTER_ACCEPT;
                        }
                    }
                );

                let count = 0;
                let node;

                while ((node = walker.nextNode()) && count < 3000) {
                    count += 1;

                    const text = node.innerText || node.textContent || '';
                    const value = extractPromptTotalFromTextBlock(text);

                    if (value > best) best = value;
                }
            }
        } catch {}

        return best;
    }

    function getManualPromptTotalOverride() {
        try {
            return parsePromptTotalNumber(localStorage.getItem('stdh4c_prompt_total_override'));
        } catch {
            return 0;
        }
    }

    function setManualPromptTotalOverride(value) {
        const n = parsePromptTotalNumber(value);

        try {
            if (n > 0) {
                localStorage.setItem('stdh4c_prompt_total_override', String(n));
                addEvent('PROMPT_TOTAL_OVERRIDE_SET', String(n));
            } else {
                localStorage.removeItem('stdh4c_prompt_total_override');
                addEvent('PROMPT_TOTAL_OVERRIDE_CLEARED');
            }
        } catch {}

        renderTokenLensUI();
        render();
    }

    
    // removed duplicate token-lens dead function by v0.4.16


    // removed duplicate token-lens dead function by v0.4.16


    // removed duplicate token-lens dead function by v0.4.16

function mountPromptTotalControls() {
        if (document.getElementById('stdh4c-token-controls')) return;

        const box = document.getElementById('stdh4c-token-lens');
        if (!box) return;

        const controls = document.createElement('div');
        controls.id = 'stdh4c-token-controls';
        controls.className = 'stdh4c-actions';

        controls.innerHTML = `
            <button id="stdh4c-read-dom-total" type="button">读取查看器</button>
            <button id="stdh4c-set-manual-total" type="button">手填总 token</button>
            <button id="stdh4c-clear-manual-total" type="button">清除手填</button>
        `;

        box.appendChild(controls);

        document.getElementById('stdh4c-read-dom-total').onclick = () => {
            const n = promptViewerDomTotalTokensV047();
            alert(n ? `读取到总 token：${n}` : '没有读取到提示词查看器总 token');
            renderTokenLensUI();
        };

        document.getElementById('stdh4c-set-manual-total').onclick = () => {
            const current = getManualPromptTotalOverride() || '';
            const value = prompt('输入提示词查看器顶部显示的总 token 数：', current);
            if (value !== null) setManualPromptTotalOverride(value);
        };

        document.getElementById('stdh4c-clear-manual-total').onclick = () => {
            setManualPromptTotalOverride('');
        };
    }



    // STDH4C_V048_REPORT_POLISH
    function latestGenerationHttpErrorV048() {
        const arr = generationHttpErrors();
        return arr.length ? arr[arr.length - 1] : null;
    }

    function latestAttemptIsTransientNetworkNoticeV048() {
        const last = state.lastGeneration;
        const err = latestGenerationHttpErrorV048();

        if (!last || !state.lastGoodGeneration || !err) return false;

        const duration = Number(last.durationMs || 0);
        const noOutput =
            !last.messageReceived &&
            (last.streamTokens || 0) === 0 &&
            !last.firstStreamAt &&
            (
                last.firstTokenLatencyMs === null ||
                last.firstTokenLatencyMs === undefined
            );

        const isNetwork =
            err.status === 'NETWORK_ERROR' ||
            String(err.status || '').includes('NETWORK');

        return Boolean(isNetwork && noOutput && duration <= 3000);
    }

    function linkHealth() {
        fixStopFalsePositiveV0420('linkHealth');
        normalizeStopState('link-health-v048');

        const genErrors = generationHttpErrors();
        const bgErrors = backgroundHttpErrors();
        const unknown = unknownHttpErrors();
        const last = preferredGenerationForReport() || state.lastGeneration;

        if (latestAttemptIsTransientNetworkNoticeV048()) {
            return {
                status: 'Healthy with transient network notice',
                reason: '最近成功生成正常；之后捕获到一次短暂网络中断提示，通常不代表本次回复失败。'
            };
        }

        if (genErrors.length > 0) {
            const latest = genErrors[genErrors.length - 1];

            return {
                status: 'Generation HTTP Error',
                reason: `捕获到生成相关 HTTP ${latest.status}：${latest.explanation}`
            };
        }

        if (!last) {
            return {
                status: 'Incomplete',
                reason: '还没有捕获完整生成。'
            };
        }

        if (last.stopped) {
            return {
                status: 'User Stopped',
                reason: '最近一次生成被用户手动停止。回复不完整时通常不应归因于模型或 API 失败。'
            };
        }

        if (!last.messageReceived) {
            return {
                status: 'Incomplete',
                reason: '最近一次生成结束，但未确认收到回复事件。'
            };
        }

        if ((last.streamTokens || 0) === 0) {
            return {
                status: 'Stream Unclear',
                reason: '最近一次生成没有捕获流式 chunk/token。若启用了流式，建议检查接口流式兼容。'
            };
        }

        if (bgErrors.length > 0) {
            return {
                status: 'Healthy with Background Notice',
                reason: '生成链路正常，但捕获到后台/扩展 HTTP 提示。'
            };
        }

        if (unknown.length > 0) {
            return {
                status: 'Healthy with Unknown HTTP Notice',
                reason: '生成链路正常，但捕获到未分类 HTTP 错误，需要结合路径判断。'
            };
        }

        return {
            status: 'Healthy',
            reason: '最近生成链路正常，未发现明显生成相关风险。'
        };
    }

    function riskText() {
        fixStopFalsePositiveV0420('riskText');
        const health = linkHealth();

        if (latestAttemptIsTransientNetworkNoticeV048()) {
            return '最近成功生成正常；短暂 NETWORK_ERROR 已降级为网络提示。若用户没有感知失败，通常无需处理。';
        }

        if (health.status === 'Generation HTTP Error') {
            return health.reason;
        }

        if (state.currentGeneration) {
            return '当前正在生成。若长时间没有首 chunk，可能需要检查上游响应、网络或请求端状态。';
        }

        const last = preferredGenerationForReport() || state.lastGeneration;

        if (!last) {
            return '还没有捕获完整生成。请先发送一条消息测试生成链路。';
        }

        if (last.stopped) {
            return '最近一次生成被标记为用户手动停止。若回复不完整，通常不应归因于模型或 API 失败。';
        }

        if ((last.streamTokens || 0) === 0) {
            return '最近一次生成未捕获流式事件。若你启用了流式，建议检查接口流式兼容或网络链路。';
        }

        return '最近生成链路正常，未发现明显生成链路风险。';
    }

    function generationImpactLines() {
        const genErrors = generationHttpErrors();
        const bgErrors = backgroundHttpErrors();
        const unknown = unknownHttpErrors();
        const last = preferredGenerationForReport() || state.lastGeneration;

        if (latestAttemptIsTransientNetworkNoticeV048()) {
            return [
                'Generation Impact: latest successful generation completed normally.',
                'A short transient NETWORK_ERROR was captured afterwards and has been downgraded to a notice.'
            ];
        }

        if (genErrors.length > 0) {
            const latest = genErrors[genErrors.length - 1];

            return [
                'Generation Impact: generation-related HTTP error captured.',
                `Latest generation-related error: HTTP_${latest.status} ${latest.method} ${latest.url}.`,
                latest.explanation
            ];
        }

        if (last && bgErrors.length > 0) {
            return [
                'Generation Impact: no generation-related HTTP errors captured.',
                'Background / extension HTTP notices were captured, but the latest generation completed normally.'
            ];
        }

        if (last && unknown.length > 0) {
            return [
                'Generation Impact: no classified generation HTTP errors captured.',
                'Unknown HTTP errors were captured; review paths before treating them as generation failures.'
            ];
        }

        if (last) {
            return [
                'Generation Impact: no generation-related HTTP errors captured.'
            ];
        }

        return [
            'Generation Impact: no complete generation captured yet.'
        ];
    }

    function clearLegacyPromptManualOverrideV048() {
        try {
            localStorage.removeItem('stdh4c_prompt_total_override');
        } catch {}
    }

    function mainPromptPressurePartV048(parts) {
        let best = { name: 'Unknown', tokens: 0 };

        for (const part of parts) {
            if (part.tokens > best.tokens) best = part;
        }

        return best;
    }

    function percentPartV048(value, total) {
        if (!total) return 0;
        return Math.round((Number(value || 0) / Math.max(1, total)) * 100);
    }

    function buildTokenLensSnapshot() {
        clearLegacyPromptManualOverrideV048();
        normalizeStopState('prompt-breakdown-v048');

        const exact = state.itemizedLensCache;
        const hasItemized = Boolean(exact?.available && exact.total > 0);

        if (hasItemized) {
            const parts = [
                { name: 'Chat History', tokens: exact.chatTokens || 0 },
                { name: 'WorldInfo', tokens: exact.worldInfoTokens || 0 },
                { name: 'System / Preset', tokens: exact.systemTokens || 0 },
                { name: 'Character', tokens: exact.characterTokens || 0 },
                { name: 'Examples', tokens: exact.examplesTokens || 0 },
                { name: 'Anchors / Injection', tokens: exact.anchorTokens || 0 }
            ];

            const main = mainPromptPressurePartV048(parts);
            const notes = [];

            notes.push('这是 SillyTavern 内部 Prompt Itemization 结构拆分，不保证等于提示词查看器顶部总 token。');

            if (exact.worldInfoTokens > 0) {
                notes.push('本次提示词包含世界书/外部上下文内容。');
            }

            if (main.tokens > 0) {
                notes.push(`当前主要 token 压力来自：${main.name}。`);
            }

            return {
                mode: 'sillytavern-itemized-breakdown',
                total: exact.total,
                promptViewerTotal: '(not accessed)',
                mainPartName: main.name,
                mainPartTokens: main.tokens,
                chatTokens: exact.chatTokens || 0,
                chatPercent: percentPartV048(exact.chatTokens, exact.total),
                characterTokens: exact.characterTokens || 0,
                characterPercent: percentPartV048(exact.characterTokens, exact.total),
                systemTokens: exact.systemTokens || 0,
                systemPercent: percentPartV048(exact.systemTokens, exact.total),
                worldInfoTokens: exact.worldInfoTokens || 0,
                worldInfoPercent: percentPartV048(exact.worldInfoTokens, exact.total),
                examplesTokens: exact.examplesTokens || 0,
                examplesPercent: percentPartV048(exact.examplesTokens, exact.total),
                anchorTokens: exact.anchorTokens || 0,
                anchorPercent: percentPartV048(exact.anchorTokens, exact.total),
                lastUserTokens: lastMessageTokens('user').tokens,
                lastAssistantTokens: lastMessageTokens('assistant').tokens,
                tokenizer: exact.tokenizer || '(unknown)',
                notes
            };
        }

        return {
            mode: 'not-available',
            total: 0,
            promptViewerTotal: '(not accessed)',
            mainPartName: 'Unknown',
            mainPartTokens: 0,
            chatTokens: 0,
            chatPercent: 0,
            characterTokens: 0,
            characterPercent: 0,
            systemTokens: 0,
            systemPercent: 0,
            worldInfoTokens: 0,
            worldInfoPercent: 0,
            examplesTokens: 0,
            examplesPercent: 0,
            anchorTokens: 0,
            anchorPercent: 0,
            lastUserTokens: lastMessageTokens('user').tokens,
            lastAssistantTokens: lastMessageTokens('assistant').tokens,
            tokenizer: '(unknown)',
            notes: [
                '未读取到 SillyTavern Prompt Itemization 数据。',
                '请先正常生成一次，再打开提示词查看器或复制报告。'
            ]
        };
    }

    function addTokenLensReport(lines) {
        const lens = buildTokenLensSnapshot();

        lines.push('');
        lines.push('## Prompt Breakdown Lens');
        lines.push('- Mode: ' + lens.mode);
        lines.push('- Internal Itemized Total Tokens: ' + (lens.total || '(not available)'));
        lines.push('- Prompt Viewer Top Total: not accessed by this plugin');
        lines.push('- Main Token Pressure: ' + lens.mainPartName + ' (' + lens.mainPartTokens + ' tokens)');
        lines.push('- Tokenizer: ' + lens.tokenizer);
        lines.push('- Chat History Tokens: ' + lens.chatTokens + ' (' + lens.chatPercent + '%)');
        lines.push('- WorldInfo Tokens: ' + lens.worldInfoTokens + ' (' + lens.worldInfoPercent + '%)');
        lines.push('- System / Preset Tokens: ' + lens.systemTokens + ' (' + lens.systemPercent + '%)');
        lines.push('- Character Definition Tokens: ' + lens.characterTokens + ' (' + lens.characterPercent + '%)');
        lines.push('- Example Messages Tokens: ' + lens.examplesTokens + ' (' + lens.examplesPercent + '%)');
        lines.push('- Anchor / Injection Tokens: ' + lens.anchorTokens + ' (' + lens.anchorPercent + '%)');
        lines.push('- Last User Message Tokens: ' + lens.lastUserTokens);
        lines.push('- Last Assistant Message Tokens: ' + lens.lastAssistantTokens);

        if (lens.notes.length) {
            lines.push('- Notes:');
            for (const note of lens.notes) lines.push('  - ' + note);
        }

        lines.push('- Privacy: token counts only; prompt text is not included.');
    }

    function removeLegacyPromptTotalControlsV048() {
        const controls = document.getElementById('stdh4c-token-controls');
        if (controls) controls.remove();
    }

    function renderTokenLensUI() {
        clearLegacyPromptManualOverrideV048();
        removeLegacyPromptTotalControlsV048();

        const summary = document.getElementById('stdh4c-token-summary');
        const detail = document.getElementById('stdh4c-token-detail');

        if (!summary || !detail) return;

        const lens = buildTokenLensSnapshot();

        summary.textContent =
            `Prompt Breakdown｜Internal Total: ${lens.total || 'unknown'}` +
            `｜Main: ${lens.mainPartName}`;

        detail.innerHTML = [
            row('Internal Itemized Total', lens.total || '(not available)'),
            row('Prompt Viewer Top Total', 'not accessed by plugin'),
            row('Main Token Pressure', `${lens.mainPartName} (${lens.mainPartTokens})`),
            row('Tokenizer', lens.tokenizer),
            row('Chat History', `${lens.chatTokens} (${lens.chatPercent}%)`),
            row('WorldInfo', `${lens.worldInfoTokens} (${lens.worldInfoPercent}%)`),
            row('System / Preset', `${lens.systemTokens} (${lens.systemPercent}%)`),
            row('Character', `${lens.characterTokens} (${lens.characterPercent}%)`),
            row('Examples', `${lens.examplesTokens} (${lens.examplesPercent}%)`),
            row('Anchors / Injection', `${lens.anchorTokens} (${lens.anchorPercent}%)`),
            row('Last User', lens.lastUserTokens),
            row('Last Assistant', lens.lastAssistantTokens),
            row('Notes', lens.notes.join(' / '))
        ].join('');
    }



    // STDH4C_COMMUNITY_BRIEF_V049
    function safeTarget(rawUrl) {
        try {
            const url = new URL(String(rawUrl || ''), location.origin);

            if (url.origin === location.origin) {
                return 'local';
            }

            return url.host || 'external';
        } catch {
            return '(unknown)';
        }
    }

    function latestHttpForCommunity() {
        const gen = generationHttpErrors();
        const bg = backgroundHttpErrors();
        const unk = unknownHttpErrors();

        if (gen.length) return gen[gen.length - 1];
        if (bg.length) return bg[bg.length - 1];
        if (unk.length) return unk[unk.length - 1];

        return null;
    }

    function requestKindForCommunity(item) {
        if (!item) return 'none';

        const category = item.category || classifyHttp(item);

        if (category === 'generation') return '生成请求';
        if (category === 'background') return '后台/扩展请求';
        if (category === 'test') return '测试请求';

        return '未分类请求';
    }

    function statusForCommunity(item) {
        if (!item) return 'none';
        return 'HTTP_' + item.status;
    }

    function secondsText(ms) {
        if (ms === null || ms === undefined) return '(not captured)';
        const n = Number(ms);
        if (!Number.isFinite(n)) return '(not captured)';
        return Math.round(n / 1000) + ' 秒';
    }

    function communityConclusion(health, last, item) {
        if (item && item.category === 'generation') {
            return '生成请求失败';
        }

        if (last && last.stopped) {
            return '用户手动停止';
        }

        if (last && last.messageReceived && !last.stopped) {
            if (item && item.category === 'background') {
                return '生成正常，后台更新失败';
            }

            return '生成正常';
        }

        if (health.status === 'Incomplete') {
            return '尚未捕获完整生成';
        }

        return health.status || '需要继续观察';
    }

    function tokenPressureBrief() {
        try {
            const lens = buildTokenLensSnapshot();

            const total =
                lens.total ||
                lens.promptTokens ||
                lens.itemizedTotalTokens ||
                0;

            const mainName =
                lens.mainPartName ||
                lens.mainPart ||
                'Unknown';

            const mainTokens =
                lens.mainPartTokens ||
                0;

            const parts = [];

            if (total) parts.push('总量 ' + total);
            parts.push('主要压力 ' + mainName + (mainTokens ? ' (' + mainTokens + ')' : ''));

            if (lens.chatTokens) parts.push('聊天历史 ' + lens.chatTokens);
            if (lens.worldInfoTokens) parts.push('世界书 ' + lens.worldInfoTokens);
            if (lens.systemTokens) parts.push('预设/系统 ' + lens.systemTokens);
            if (lens.characterTokens) parts.push('角色 ' + lens.characterTokens);

            if (lens.characterTokens === 0) {
                parts.push('角色=0 仅表示未被 itemization 单独归类，不代表角色卡无效');
            }

            return parts.join('；');
        } catch {
            return '未读取到提示词结构数据';
        }
    }

    function shortPathForCommunity(item) {
        if (!item) return 'none';

        const raw = String(item.url || '');
        const path = raw.replace(/^(local|external):/, '');

        if (path.length > 96) {
            return path.slice(0, 96) + '...';
        }

        return path || 'unknown';
    }


    // STDH4C_PROVIDER_HOST_HINT_V0410
    function hostOnlyFromUrl(raw) {
        try {
            const text = String(raw || '').trim();

            if (!/^https?:\/\//i.test(text)) return '';

            const url = new URL(text);
            const host = String(url.hostname || '').trim();

            if (!host) return '';

            if (
                host === 'localhost' ||
                host === '127.0.0.1' ||
                host === '0.0.0.0' ||
                host === location.hostname
            ) {
                return 'local';
            }

            return host.replace(/^www\./i, '');
        } catch {
            return '';
        }
    }

    function isProbablySecretKeyName(key) {
        const k = String(key || '').toLowerCase();

        return (
            k.includes('key') ||
            k.includes('token') ||
            k.includes('secret') ||
            k.includes('password') ||
            k.includes('passwd') ||
            k.includes('auth') ||
            k.includes('bearer') ||
            k.includes('cookie') ||
            k.includes('header') ||
            k.includes('body') ||
            k.includes('prompt') ||
            k.includes('message') ||
            k.includes('history') ||
            k.includes('content')
        );
    }

    function isProbablyProviderUrlKey(key) {
        const k = String(key || '').toLowerCase();

        if (
            k.includes('homepage') ||
            k.includes('home_page') ||
            k.includes('github') ||
            k.includes('repo') ||
            k.includes('repository') ||
            k.includes('license') ||
            k.includes('readme')
        ) {
            return false;
        }

        return (
            k.includes('reverse') ||
            k.includes('proxy') ||
            k.includes('endpoint') ||
            k.includes('baseurl') ||
            k.includes('base_url') ||
            k.includes('apiurl') ||
            k.includes('api_url') ||
            k.includes('serverurl') ||
            k.includes('server_url') ||
            k === 'url' ||
            k === 'host'
        );
    }

    function pushProviderHostCandidate(out, source, key, value) {
        if (!isProbablyProviderUrlKey(key)) return;
        if (isProbablySecretKeyName(key)) return;

        const host = hostOnlyFromUrl(value);

        if (!host || host === 'local') return;

        const badHosts = new Set([
            'github.com',
            'raw.githubusercontent.com',
            'cdn.jsdelivr.net',
            'localhost',
            '127.0.0.1'
        ]);

        if (badHosts.has(host)) return;

        out.push({
            host,
            source: source + '.' + key
        });
    }

    function scanProviderObject(out, source, obj, depth = 0, seen = new WeakSet()) {
        if (!obj || typeof obj !== 'object') return;
        if (seen.has(obj)) return;
        if (depth > 3) return;

        seen.add(obj);

        let entries = [];

        try {
            entries = Object.entries(obj);
        } catch {
            return;
        }

        for (const [key, value] of entries) {
            if (isProbablySecretKeyName(key)) continue;

            if (typeof value === 'string') {
                pushProviderHostCandidate(out, source, key, value);
                continue;
            }

            if (
                value &&
                typeof value === 'object' &&
                (
                    isProbablyProviderUrlKey(key) ||
                    key === 'chat_completion' ||
                    key === 'openai' ||
                    key === 'custom' ||
                    key === 'settings'
                )
            ) {
                scanProviderObject(out, source + '.' + key, value, depth + 1, seen);
            }
        }
    }

    function providerHostHintForCommunity() {
        const manual = manualProviderHostForCommunity();
        if (manual) {
            return manual + '（用户填写，仅域名/名称，插件未验证）';
        }

        const out = [];

        try {
            if (window.oai_settings) {
                scanProviderObject(out, 'oai_settings', window.oai_settings);
            }

            if (window.textgenerationwebui_settings) {
                scanProviderObject(out, 'textgenerationwebui_settings', window.textgenerationwebui_settings);
            }

            if (window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
                const ctx = window.SillyTavern.getContext();

                if (ctx && ctx.oai_settings) {
                    scanProviderObject(out, 'context.oai_settings', ctx.oai_settings);
                }

                if (ctx && ctx.extensionSettings) {
                    scanProviderObject(out, 'context.extensionSettings', ctx.extensionSettings);
                }
            }
        } catch {
            // ignore: host hint must never break diagnostics
        }

        const unique = [];
        const seen = new Set();

        for (const item of out) {
            if (!item || !item.host) continue;
            if (seen.has(item.host)) continue;

            seen.add(item.host);
            unique.push(item);
        }

        if (!unique.length) {
            return 'not detected（浏览器侧只看到 local 请求，未读取到上游域名）';
        }

        const first = unique[0];

        if (unique.length === 1) {
            return `${first.host}（仅显示域名，不含 path/query/key）`;
        }

        return `${first.host} 等 ${unique.length} 个候选（仅显示域名，不含 path/query/key）`;
    }



    // STDH4C_MANUAL_PROVIDER_HINT_V0411
    const MANUAL_PROVIDER_KEY_V0411 = 'stdh4c.manualProviderHost';

    function sanitizeManualProviderHost(raw) {
        let text = String(raw || '').trim();

        if (!text) return '';

        text = text.replace(/[\r\n\t]/g, ' ').trim();

        if (text.length > 200) {
            text = text.slice(0, 200);
        }

        // 如果用户输入完整 URL，只保留 hostname
        try {
            if (/^https?:\/\//i.test(text)) {
                const url = new URL(text);
                text = url.hostname || '';
            }
        } catch {
            // ignore
        }

        // 如果用户输入 host/path?key=xxx，只保留 host
        text = text.split('?')[0].split('#')[0].split('/')[0].trim();

        // 去掉常见端口；如果你希望保留端口，可以删掉这一行
        text = text.replace(/:\d+$/, '');

        // 去掉 www.
        text = text.replace(/^www\./i, '');

        // 极简安全过滤：不允许空格、引号、尖括号、反斜杠
        text = text.replace(/[<>"'`\\\s]/g, '');

        if (text.length > 80) {
            text = text.slice(0, 80);
        }

        // 明显是密钥形态就拒绝
        const lower = text.toLowerCase();
        if (
            lower.includes('sk-') ||
            lower.includes('bearer') ||
            lower.includes('token') ||
            lower.includes('apikey') ||
            lower.includes('api_key') ||
            lower.includes('secret')
        ) {
            return '';
        }

        return text;
    }

    function manualProviderHostForCommunity() {
        try {
            const saved = localStorage.getItem(MANUAL_PROVIDER_KEY_V0411);
            const clean = sanitizeManualProviderHost(saved);
            return clean || '';
        } catch {
            return '';
        }
    }

    function setManualProviderHostV0411() {
        const current = manualProviderHostForCommunity();

        const input = prompt(
            '填写上游域名线索：\n只建议填写服务商主域名或名称。\n不要填写 API key、token、完整带参数链接。\n例如：api.example.com',
            current || ''
        );

        if (input === null) return;

        const clean = sanitizeManualProviderHost(input);

        if (!clean) {
            alert('没有保存：输入为空，或疑似包含密钥/非法字符。');
            return;
        }

        localStorage.setItem(MANUAL_PROVIDER_KEY_V0411, clean);
        addEvent('MANUAL_PROVIDER_HOST_SET', clean);

        alert('已保存上游域名线索：' + clean);

        try {
            render();
        } catch {
            // ignore
        }

        if (typeof stdh4cMountAddonPanelsV0418 === 'function') {
            stdh4cMountAddonPanelsV0418();
        } else {
            if (typeof stdh4cMountAddonPanelsV0418 === 'function') {
            stdh4cMountAddonPanelsV0418();
        } else {
            setTimeout(mountManualProviderHostPanelV0411, 50);
        }
        }
    }

    function clearManualProviderHostV0411() {
        localStorage.removeItem(MANUAL_PROVIDER_KEY_V0411);
        addEvent('MANUAL_PROVIDER_HOST_CLEARED');

        alert('已清除上游域名线索。');

        try {
            render();
        } catch {
            // ignore
        }

        if (typeof stdh4cMountAddonPanelsV0418 === 'function') {
            stdh4cMountAddonPanelsV0418();
        } else {
            if (typeof stdh4cMountAddonPanelsV0418 === 'function') {
            stdh4cMountAddonPanelsV0418();
        } else {
            setTimeout(mountManualProviderHostPanelV0411, 50);
        }
        }
    }

    function mountManualProviderHostPanelV0411() {
        const panel =
            document.getElementById('stdh4c-panel') ||
            document.querySelector('[id$="-panel"]');

        if (!panel) return;

        let box = document.getElementById('stdh4c-manual-provider-box');

        const current = manualProviderHostForCommunity() || 'not set';

        if (!box) {
            box = document.createElement('div');
            box.id = 'stdh4c-manual-provider-box';
            box.style.border = '1px solid rgba(80,180,255,0.55)';
            box.style.borderRadius = '10px';
            box.style.padding = '10px';
            box.style.margin = '10px 0';
            box.style.background = 'rgba(0,30,55,0.35)';
            box.style.fontSize = '14px';
            box.style.lineHeight = '1.6';

            box.innerHTML = `
                <div style="font-weight:700;color:#55c7ff;margin-bottom:6px;">
                    上游域名线索 / Provider Host Hint
                </div>
                <div id="stdh4c-manual-provider-current" style="word-break:break-all;margin-bottom:8px;"></div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                    <button id="stdh4c-set-manual-provider" type="button">填写/修改</button>
                    <button id="stdh4c-clear-manual-provider" type="button">清除</button>
                </div>
                <div style="opacity:.75;margin-top:6px;font-size:12px;">
                    仅保存域名/名称，不保存 path、query、headers、body 或 API key。社区规则仍需人工判断。
                </div>
            `;

            const firstHr = panel.querySelector('hr');
            if (firstHr && firstHr.parentNode) {
                firstHr.parentNode.insertBefore(box, firstHr.nextSibling);
            } else {
                panel.appendChild(box);
            }

            const setBtn = box.querySelector('#stdh4c-set-manual-provider');
            const clearBtn = box.querySelector('#stdh4c-clear-manual-provider');

            if (setBtn) {
                setBtn.onclick = ev => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    setManualProviderHostV0411();
                };
            }

            if (clearBtn) {
                clearBtn.onclick = ev => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    clearManualProviderHostV0411();
                };
            }
        }

        const currentEl = document.getElementById('stdh4c-manual-provider-current');
        if (currentEl) {
            currentEl.textContent = '当前：' + current;
        }
    }



    // STDH4C_STREAM_SHORT_V0412
    function streamLastGenerationV0412() {
        try {
            if (typeof preferredGenerationForReport === 'function') {
                const g = preferredGenerationForReport();
                if (g) return g;
            }
        } catch {}
        return state.lastGeneration || null;
    }

    function streamLastAssistantTokensV0412() {
        try {
            const lens = buildTokenLensSnapshot();
            const list = [
                lens.lastAssistantTokens,
                lens.lastAssistantMessageTokens,
                lens.assistantTokens
            ];
            for (const v of list) {
                const n = Number(v);
                if (Number.isFinite(n) && n > 0) return n;
            }
        } catch {}
        return 0;
    }

    function streamModeSnapshotV0412() {
        const last = streamLastGenerationV0412();

        if (!last) {
            return {
                type: 'unknown',
                observed: 'no',
                chunks: 0,
                tpc: 0,
                reason: '尚未捕获完整生成。'
            };
        }

        const chunks = Number(last.streamTokens || 0);
        const assistantTokens = streamLastAssistantTokensV0412();
        const tpc = chunks > 0 && assistantTokens > 0
            ? Math.round(assistantTokens / chunks)
            : 0;

        if (chunks === 0 && last.messageReceived) {
            return {
                type: 'non-stream-or-buffered',
                observed: 'no',
                chunks,
                tpc,
                reason: '收到回复但未观察到 chunk，可能是非流式或完整缓冲返回。'
            };
        }

        if (chunks === 0) {
            return {
                type: 'no-output-observed',
                observed: 'no',
                chunks,
                tpc,
                reason: '未观察到输出 chunk。'
            };
        }

        if (tpc >= 80) {
            return {
                type: 'coarse-buffered-stream',
                observed: 'yes',
                chunks,
                tpc,
                reason: '观察到 chunk，但每个 chunk 承载 token 较多，更像粗粒度缓冲/假流式。'
            };
        }

        if (tpc >= 20) {
            return {
                type: 'buffered-stream',
                observed: 'yes',
                chunks,
                tpc,
                reason: '观察到 chunk，但粒度偏粗，可能是 buffered streaming。'
            };
        }

        return {
            type: 'stream-observed',
            observed: 'yes',
            chunks,
            tpc,
            reason: '观察到多次 chunk，前端表现接近流式输出。'
        };
    }

    function streamModeCommunityLinesV0412() {
        const x = streamModeSnapshotV0412();
        return [
            '- 前端是否观察到流式 chunk：' + x.observed,
            '- 流式观察类型：' + x.type,
            '- 捕获 chunk：' + x.chunks,
            '- 估算 token / chunk：' + (x.tpc ? ('约 ' + x.tpc) : 'not available'),
            '- 说明：' + x.reason,
            '- 边界：插件不读取 request body，因此不能证明 stream:true；这里只展示前端实际观察到的输出形态。'
        ];
    }



    // STDH4C_ACTION_SUGGESTION_V0413
    function communityLastGenerationV0413() {
        try {
            if (typeof preferredGenerationForReport === 'function') {
                const g = preferredGenerationForReport();
                if (g) return g;
            }
        } catch {}
        return state.lastGeneration || null;
    }

    function communityLatestHttpV0413() {
        try {
            if (typeof latestHttpForCommunity === 'function') {
                return latestHttpForCommunity();
            }
        } catch {}
        return null;
    }

    function communityActionSuggestionV0413() {
        const last = communityLastGenerationV0413();
        const item = communityLatestHttpV0413();

        if (item && item.category === 'generation') {
            const st = String(item.status || '').toUpperCase();

            if (st === 'HTTP_401' || st === '401') {
                return '生成请求被拒绝：优先检查 API key、账号状态或服务商授权。';
            }

            if (st === 'HTTP_403' || st === '403') {
                return '生成请求被拒绝：检查模型权限、账号/地区/IP 策略、服务商规则；不要盲目高频重试。';
            }

            if (st === 'HTTP_429' || st === '429') {
                return '请求过多或额度受限：降低并发和重试频率，等待额度恢复；公益站场景先看额度和规则。';
            }

            if (st === 'HTTP_500' || st === '500') {
                return '上游或反代返回 500：优先检查服务商状态、反代后端日志和当前模型是否可用。';
            }

            if (st === 'HTTP_502' || st === '502') {
                return '网关/反代异常：检查中转站、上游连接、代理链路或服务商临时故障。';
            }

            if (st === 'HTTP_503' || st === '503') {
                return '服务暂不可用：可能是上游维护、排队或过载；建议稍后重试。';
            }

            if (st === 'HTTP_524' || st === '524') {
                return 'Cloudflare 524 超时：通常是上游响应太慢、上下文过长或反代超时；建议减少上下文/世界书并检查上游耗时。';
            }

            if (st.includes('NETWORK_ERROR')) {
                return '浏览器未拿到有效 HTTP 响应：优先检查本地 ST 后端、节点/代理、TLS、CORS 或链路中断。';
            }

            return '生成请求失败：根据状态码、服务商规则和上游日志继续排查。';
        }

        if (last && last.stopped) {
            return '最近一次是用户手动停止：回复不完整通常不应归因于模型、API 或服务商故障。';
        }

        if (last && last.messageReceived && !last.stopped) {
            if (item && item.category === 'background') {
                return '生成本身正常；后台扩展/version 检查失败通常可忽略，需要更新插件时再检查 GitHub 网络。';
            }

            try {
                if (typeof streamModeSnapshotV0412 === 'function') {
                    const sm = streamModeSnapshotV0412();
                    if (sm && String(sm.type || '').includes('buffered')) {
                        return '生成正常；流式表现为粗粒度缓冲/假流式，这通常是上游或适配器输出形态，不一定是故障。';
                    }
                }
            } catch {}

            return '生成链路正常：若用户仍觉得慢，优先看首 chunk 延迟、上下文长度、世界书占用和节点质量。';
        }

        if (!last) {
            return '还没有完整生成记录：请先发送一条短消息测试，再复制社区简报。';
        }

        return '信息不足：建议复制完整本地报告或补充报错截图。';
    }


    function buildCommunityReport() {
        fixStopFalsePositiveV0420('buildCommunityReport');
        sanitizeGenerationState('community-report');

        const snap = getSnapshot();
        const health = linkHealth();
        const last = typeof preferredGenerationForReport === 'function'
            ? preferredGenerationForReport()
            : state.lastGeneration;
        const item = latestHttpForCommunity();

        const lines = [];

        lines.push('# ST Diagnostic Helper 社区简报');
        lines.push('');
        lines.push('## 一句话结论');
        lines.push('- 结论：' + communityConclusion(health, last, item));
        lines.push('- 状态：' + health.status);
        lines.push('- 说明：' + health.reason);

        lines.push('');
        lines.push('## 建议动作');
        lines.push('- ' + communityActionSuggestionV0413());

        lines.push('');
        lines.push('## 请求目标');
        lines.push('- 请求目标：' + (item?.target || 'local / not captured'));
        lines.push('- 上游域名线索：' + providerHostHintForCommunity());
        lines.push('- 路径分类：' + requestKindForCommunity(item));
        lines.push('- 安全路径：' + shortPathForCommunity(item));
        lines.push('- 状态码：' + statusForCommunity(item));
        lines.push('- 耗时：' + (item ? item.durationMs + 'ms' : 'none'));
        lines.push('- 服务商判断：插件只展示请求目标与路径类型，请答疑者按社区规则自行判断是否认可。');

        lines.push('');
        lines.push('## 请求/流式模式');
        for (const line of streamModeCommunityLinesV0412()) {
            lines.push(line);
        }

        lines.push('');
        lines.push('## 生成状态');
        if (last) {
            lines.push('- 生成耗时：' + secondsText(last.durationMs));
            lines.push('- 首 chunk 延迟：' + secondsText(last.firstTokenLatencyMs));
            lines.push('- 捕获 chunk：' + (last.streamTokens || 0));
            lines.push('- 是否收到回复：' + (last.messageReceived ? 'yes' : 'no'));
            lines.push('- 是否用户停止：' + (last.stopped ? 'yes' : 'no'));
            lines.push('- 触发类型：' + (last.triggerType || 'unknown'));
        } else {
            lines.push('- 尚未捕获完整生成。');
        }

        lines.push('');
        lines.push('## 提示词压力');
        lines.push('- ' + tokenPressureBrief());

        lines.push('');
        lines.push('## 基础环境');
        lines.push('- API：' + snap.api);
        lines.push('- Source：' + snap.source);
        lines.push('- Model：' + snap.model);
        lines.push('- Messages：' + snap.messages);

        lines.push('');
        lines.push('## 隐私');
        lines.push('- 未记录聊天正文、prompt 正文、API key、headers、request body、response body、query string。');
        lines.push('- 社区简报隐藏 preset、角色名和 chat ID。');

        lines.push('');
        lines.push('## 备注');
        lines.push('- 完整 timeline 已从社区简报移除；需要深度排错时请复制“完整报告”。');
        lines.push('- Prompt Breakdown 是 SillyTavern 内部结构拆分，不保证等于提示词查看器顶部总 token。');

        return lines.join('\n');
    }



    // STDH4C_ADVANCED_HTTP_FOLD_V0414
    function stdh4cIsSimButtonV0414(btn) {
        const text = String(btn?.textContent || '').trim();

        if (!text) return false;

        const isSim =
            /测试|模拟|simulate|403|404|429|500|502|503|524|network/i.test(text);

        const keepOutside =
            /清空|复制|刷新|关闭|填写|修改|开启高级|关闭高级|copy|refresh|clear/i.test(text);

        return isSim && !keepOutside;
    }

    function stdh4cAdvancedHttpFoldV0414() {
        const panel =
            document.getElementById('stdh4c-panel') ||
            document.querySelector('[id$="-panel"]');

        if (!panel) return;

        let box = document.getElementById('stdh4c-advanced-http-fold');

        if (!box) {
            box = document.createElement('div');
            box.id = 'stdh4c-advanced-http-fold';
            box.style.border = '1px solid rgba(255,190,80,0.55)';
            box.style.borderRadius = '10px';
            box.style.padding = '10px';
            box.style.margin = '10px 0';
            box.style.background = 'rgba(60,40,0,0.28)';
            box.style.fontSize = '14px';
            box.style.lineHeight = '1.6';

            box.innerHTML = `
                <details id="stdh4c-advanced-http-details">
                    <summary style="font-weight:700;color:#ffc45a;cursor:pointer;">
                        高级 HTTP 测试 / Advanced HTTP Tests
                    </summary>
                    <div style="opacity:.75;margin:8px 0;font-size:12px;">
                        这里仅放 403 / 429 / 500 / 524 等模拟测试按钮。正常社区排错无需展开。
                    </div>
                    <div id="stdh4c-advanced-http-buttons"
                         style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
                    </div>
                    <div style="opacity:.75;margin-top:8px;font-size:12px;">
                        模拟按钮只用于开发验证，不代表真实请求失败。
                    </div>
                </details>
            `;

            const providerBox = document.getElementById('stdh4c-manual-provider-box');
            const streamBox = document.getElementById('stdh4c-stream-mode-box');

            if (streamBox && streamBox.parentNode) {
                streamBox.parentNode.insertBefore(box, streamBox.nextSibling);
            } else if (providerBox && providerBox.parentNode) {
                providerBox.parentNode.insertBefore(box, providerBox.nextSibling);
            } else {
                const hr = panel.querySelector('hr');
                if (hr && hr.parentNode) {
                    hr.parentNode.insertBefore(box, hr.nextSibling);
                } else {
                    panel.appendChild(box);
                }
            }
        }

        const target = document.getElementById('stdh4c-advanced-http-buttons');
        if (!target) return;

        const buttons = Array.from(panel.querySelectorAll('button'));

        for (const btn of buttons) {
            if (!stdh4cIsSimButtonV0414(btn)) continue;
            if (target.contains(btn)) continue;

            target.appendChild(btn);
        }

        if (!target.children.length) {
            target.textContent = '暂无模拟测试按钮。需要测试时，可先开启旧版 HTTP 模拟面板或完整报告测试项。';
        } else {
            for (const node of Array.from(target.childNodes)) {
                if (node.nodeType === Node.TEXT_NODE) node.remove();
            }
        }
    }



    // STDH4C_SIM_BUTTONS_V0415
    function stdh4cShortTimeV0415() {
        const d = new Date();
        return [
            String(d.getHours()).padStart(2, '0'),
            String(d.getMinutes()).padStart(2, '0'),
            String(d.getSeconds()).padStart(2, '0')
        ].join(':');
    }

    function stdh4cExplainSimV0415(status) {
        const s = String(status).toUpperCase();

        if (s === '403') {
            return '403 Forbidden｜服务器理解请求，但拒绝处理。常见原因：模型权限、账号/地区/IP 策略、服务商规则或请求来源不合规。';
        }

        if (s === '429') {
            return '429 Too Many Requests｜请求过多或额度受限。常见原因：RPM/TPM 超限、并发过高、公益站额度限制。';
        }

        if (s === '500') {
            return '500 Server Error｜上游、反代或服务端内部异常。建议检查服务商状态、反代日志和模型可用性。';
        }

        if (s === '502') {
            return '502 Bad Gateway｜网关或反代无法从上游获得有效响应。常见于中转站、上游连接或代理链路异常。';
        }

        if (s === '503') {
            return '503 Service Unavailable｜服务暂不可用。可能是上游维护、排队、过载或临时不可用。';
        }

        if (s === '524') {
            return '524 Cloudflare Timeout｜Cloudflare 已连接源站，但源站超时未返回。常见于上游太慢、上下文过长或反代超时。';
        }

        if (s.includes('NETWORK')) {
            return 'NETWORK_ERROR｜浏览器 fetch 没拿到有效 HTTP 响应。常见原因：网络断开、连接重置、本地后端不可达、TLS/CORS/代理链路问题。';
        }

        return '模拟 HTTP 错误，仅用于开发验证。';
    }

    function stdh4cPushSimHttpV0415(status) {
        const isNetwork = String(status).toUpperCase().includes('NETWORK');
        const code = isNetwork ? 'NETWORK_ERROR' : Number(status);
        const duration = String(status) === '524' ? 100000 : 4321;

        const item = {
            id: 'sim-' + Date.now() + '-' + Math.random().toString(16).slice(2),
            time: new Date().toISOString(),
            shortTime: stdh4cShortTimeV0415(),
            category: 'generation',
            method: 'POST',
            url: 'local:/api/backends/stdh4c-simulated/generate',
            target: 'local',
            status: code,
            durationMs: duration,
            explanation: stdh4cExplainSimV0415(status)
        };

        let pushed = false;

        try {
            if (typeof recordHttpError === 'function') {
                recordHttpError({
                    method: item.method,
                    url: item.url,
                    status: item.status,
                    durationMs: item.durationMs,
                    category: item.category,
                    explanation: item.explanation
                });
                pushed = true;
            }
        } catch {
            pushed = false;
        }

        if (!pushed) {
            try {
                if (!Array.isArray(state.httpErrors)) state.httpErrors = [];
                state.httpErrors.push(item);
                if (state.httpErrors.length > 60) state.httpErrors.shift();
                pushed = true;
            } catch {
                pushed = false;
            }
        }

        try {
            addEvent('HTTP_SIMULATED_' + String(status).toUpperCase());
        } catch {}

        try {
            render();
        } catch {}

        alert(
            pushed
                ? '已模拟 HTTP ' + status + '。请复制社区简报或完整报告查看分类。'
                : '模拟失败：未找到可写入的 HTTP 日志结构。'
        );
    }

    function stdh4cEnsureSimButtonsV0415() {
        try {
            if (typeof stdh4cAdvancedHttpFoldV0414 === 'function') {
                stdh4cAdvancedHttpFoldV0414();
            }
        } catch {}

        const target = document.getElementById('stdh4c-advanced-http-buttons');
        if (!target) return;

        const specs = [
            ['403', '测试 403'],
            ['429', '测试 429'],
            ['500', '测试 500'],
            ['502', '测试 502'],
            ['503', '测试 503'],
            ['524', '测试 524'],
            ['NETWORK_ERROR', '测试 NETWORK']
        ];

        for (const [status, label] of specs) {
            const id = 'stdh4c-sim-' + String(status).replace(/[^a-z0-9]/gi, '-').toLowerCase();

            if (document.getElementById(id)) continue;

            const btn = document.createElement('button');
            btn.id = id;
            btn.type = 'button';
            btn.textContent = label;
            btn.onclick = ev => {
                ev.preventDefault();
                ev.stopPropagation();
                stdh4cPushSimHttpV0415(status);
            };

            target.appendChild(btn);
        }

        for (const node of Array.from(target.childNodes)) {
            if (node.nodeType === Node.TEXT_NODE) node.remove();
        }
    }



    // STDH4C_MERGE_UI_TIMERS_V0418
    function stdh4cMountAddonPanelsV0418() {
        try { mountMiniCommunityReportPanelV0421(); } catch {}
        try {
            if (typeof mountManualProviderHostPanelV0411 === 'function') {
                mountManualProviderHostPanelV0411();
            }
        } catch {}

        try {
            if (typeof stdh4cAdvancedHttpFoldV0414 === 'function') {
                stdh4cAdvancedHttpFoldV0414();
            }
        } catch {}

        try {
            if (typeof stdh4cEnsureSimButtonsV0415 === 'function') {
                stdh4cEnsureSimButtonsV0415();
            }
        } catch {}
    }



    // STDH4C_MINI_COMMUNITY_REPORT_V0421
    function miniValueV0421(value, fallback = 'unknown') {
        if (value === null || value === undefined) return fallback;
        const text = String(value).trim();
        return text || fallback;
    }

    function miniNumberV0421(...values) {
        for (const value of values) {
            const n = Number(value);
            if (Number.isFinite(n) && n > 0) return n;
        }
        return 0;
    }

    function miniCleanProviderV0421() {
        try {
            if (typeof manualProviderHostForCommunity === 'function') {
                const host = manualProviderHostForCommunity();
                if (host) return host;
            }
        } catch {}

        try {
            if (typeof providerHostHintForCommunity === 'function') {
                const hint = providerHostHintForCommunity();
                return String(hint || '')
                    .split('（')[0]
                    .replace('not detected', '')
                    .trim() || 'not detected';
            }
        } catch {}

        return 'not detected';
    }

    function miniStatusV0421() {
        try {
            const health = linkHealth();

            if (!health) return 'unknown';

            if (health.status === 'Healthy') return '生成正常';
            if (health.status === 'User Stopped') return '用户手动停止';
            if (health.status === 'Healthy with Background Notice') return '生成正常，后台提示';
            if (health.status === 'Healthy with transient network notice') return '生成正常，短暂网络提示';
            if (health.status === 'Generation HTTP Error') return '生成请求失败';

            return health.status || 'unknown';
        } catch {
            return 'unknown';
        }
    }

    function miniHttpV0421() {
        try {
            if (typeof latestHttpForCommunity === 'function') {
                const item = latestHttpForCommunity();

                if (!item) return '无';

                const status = miniValueV0421(item.status, 'none');
                const path = miniValueV0421(item.safePath || item.url, 'none');

                if (status === 'none' && path === 'none') return '无';

                return status + ' / ' + path;
            }
        } catch {}

        return '无';
    }

    function miniStreamV0421() {
        try {
            if (typeof streamModeSnapshotV0412 === 'function') {
                const sm = streamModeSnapshotV0412();

                if (!sm) return 'unknown';

                const type = miniValueV0421(sm.type || sm.mode, 'unknown');
                const chunks = miniNumberV0421(sm.chunks);

                if (chunks > 0) return type + '，chunk ' + chunks;
                return type;
            }
        } catch {}

        return 'unknown';
    }

    function miniPromptV0421() {
        try {
            if (typeof buildTokenLensSnapshot !== 'function') {
                return {
                    total: 'unknown',
                    pressure: 'unknown'
                };
            }

            const lens = buildTokenLensSnapshot() || {};

            const total = miniNumberV0421(
                lens.promptTokens,
                lens.itemizedTotalTokens,
                lens.itemizedTotal,
                lens.bestAvailablePromptTokens
            );

            const chat = miniNumberV0421(lens.chatTokens, lens.chatHistoryTokens);
            const world = miniNumberV0421(lens.worldInfoTokens, lens.worldTokens);
            const system = miniNumberV0421(lens.systemTokens, lens.systemPresetTokens);
            const character = miniNumberV0421(lens.characterTokens, lens.charTokens);

            const parts = [
                ['Chat History', chat],
                ['WorldInfo', world],
                ['System/Preset', system],
                ['Character', character]
            ].filter(x => x[1] > 0);

            parts.sort((a, b) => b[1] - a[1]);

            return {
                total: total || 'unknown',
                pressure: parts.length ? (parts[0][0] + ' ' + parts[0][1]) : 'unknown'
            };
        } catch {
            return {
                total: 'unknown',
                pressure: 'unknown'
            };
        }
    }

    function miniSuggestionV0421() {
        try {
            if (typeof communityActionSuggestionV0413 === 'function') {
                return communityActionSuggestionV0413();
            }
        } catch {}

        return '信息不足；需要深度排错时请复制完整报告。';
    }


    // STDH4C_MINI_FIELDS_FIX_V0422
    function miniPresetV0422(snap) {
        const value = snap && snap.preset;
        const text = String(value || '').trim();

        if (!text || text === '(unknown)' || text === 'unknown') {
            return 'unknown';
        }

        return text;
    }

    function miniPickNumberV0422(obj, keys) {
        if (!obj) return 0;

        for (const key of keys) {
            const n = Number(obj[key]);
            if (Number.isFinite(n) && n > 0) return n;
        }

        return 0;
    }

    function miniPromptV0422() {
        try {
            if (typeof buildTokenLensSnapshot !== 'function') {
                return {
                    total: 'unknown',
                    pressure: 'unknown'
                };
            }

            const lens = buildTokenLensSnapshot() || {};

            const chat = miniPickNumberV0422(lens, [
                'chatTokens',
                'chatHistoryTokens',
                'chatHistory',
                'chat'
            ]);

            const world = miniPickNumberV0422(lens, [
                'worldInfoTokens',
                'worldTokens',
                'worldInfo',
                'world'
            ]);

            const system = miniPickNumberV0422(lens, [
                'systemTokens',
                'systemPresetTokens',
                'presetTokens',
                'systemPreset',
                'system'
            ]);

            const character = miniPickNumberV0422(lens, [
                'characterTokens',
                'charTokens',
                'character'
            ]);

            const examples = miniPickNumberV0422(lens, [
                'exampleTokens',
                'examplesTokens',
                'exampleMessagesTokens',
                'examples'
            ]);

            let total = miniPickNumberV0422(lens, [
                'promptTokens',
                'bestAvailablePromptTokens',
                'itemizedTotalTokens',
                'itemizedTotal',
                'internalItemizedTotalTokens',
                'internalTotalTokens',
                'totalTokens',
                'total'
            ]);

            if (!total) {
                total = chat + world + system + character + examples;
            }

            const parts = [
                ['Chat History', chat],
                ['WorldInfo', world],
                ['System/Preset', system],
                ['Character', character],
                ['Examples', examples]
            ].filter(x => x[1] > 0);

            parts.sort((a, b) => b[1] - a[1]);

            return {
                total: total || 'unknown',
                pressure: parts.length ? (parts[0][0] + ' ' + parts[0][1]) : 'unknown'
            };
        } catch {
            return {
                total: 'unknown',
                pressure: 'unknown'
            };
        }
    }



    // STDH4C_MINI_READABLE_V0423
    function miniStatusV0423() {
        try {
            const health = linkHealth();
            const status = String(health && health.status || '');

            if (status === 'Healthy') {
                return '✅ 生成正常';
            }

            if (status === 'User Stopped') {
                return '⏹ 用户手动停止';
            }

            if (status === 'Healthy with Background Notice') {
                return '✅ 生成正常，后台提示';
            }

            if (status === 'Healthy with transient network notice') {
                return '✅ 生成正常，短暂网络提示';
            }

            if (status === 'Generation HTTP Error') {
                return '❌ 生成请求失败';
            }

            if (status === 'Incomplete') {
                return '⚠ 尚未捕获完整生成';
            }

            return status || 'unknown';
        } catch {
            return 'unknown';
        }
    }

    function miniStreamV0423() {
        try {
            if (typeof streamModeSnapshotV0412 !== 'function') {
                return 'unknown';
            }

            const sm = streamModeSnapshotV0412();
            const type = String(sm.type || sm.mode || 'unknown');
            const chunks = Number(sm.chunks || 0);

            let label = type;

            if (type === 'coarse-buffered-stream') {
                label = '粗粒度缓冲/假流式特征';
            } else if (type === 'buffered-stream') {
                label = '缓冲流式/疑似假流式';
            } else if (type === 'stream-observed') {
                label = '流式已观察';
            } else if (type === 'non-stream-or-buffered') {
                label = '未观察到流式/可能完整缓冲';
            } else if (type === 'very-coarse-buffered-stream') {
                label = '极粗粒度缓冲';
            } else if (type === 'failed-or-aborted') {
                label = '失败或中断，未形成有效流式判断';
            } else if (type === 'no-output-observed') {
                label = '未观察到输出 chunk';
            }

            if (chunks > 0) {
                return label + '，chunk ' + chunks;
            }

            return label;
        } catch {
            return 'unknown';
        }
    }

    function miniPromptV0423() {
        let info;

        try {
            info = miniPromptV0422();
        } catch {
            info = {
                total: 'unknown',
                pressure: 'unknown'
            };
        }

        const total = Number(info.total);
        const pressure = String(info.pressure || 'unknown');

        const match = pressure.match(/^(.+?)\s+(\d+)$/);

        if (Number.isFinite(total) && total > 0 && match) {
            const name = match[1];
            const value = Number(match[2]);

            if (Number.isFinite(value) && value > 0) {
                const percent = Math.round(value / total * 100);
                return {
                    total: info.total,
                    pressure: name + ' ' + value + ' (' + percent + '%)'
                };
            }
        }

        return info;
    }



    // STDH4C_MINI_PRIORITY_FIX_V0424
    function miniGenV0424() {
        try {
            if (typeof fixStopFalsePositiveV0420 === 'function') {
                fixStopFalsePositiveV0420('mini-v0424');
            }
        } catch {}

        try {
            if (typeof preferredGenerationForReport === 'function') {
                const g = preferredGenerationForReport();
                if (g) return g;
            }
        } catch {}

        return state.lastGeneration || state.lastSuccessfulGeneration || null;
    }

    function miniLatestHttpV0424() {
        try {
            if (typeof latestHttpForCommunity === 'function') {
                return latestHttpForCommunity();
            }
        } catch {}

        return null;
    }

    function miniGenCompletedV0424(gen) {
        return Boolean(
            gen &&
            gen.messageReceived &&
            Number(gen.streamTokens || 0) > 0
        );
    }

    function miniHttpStatusV0424(item) {
        if (!item) return 'none';

        const raw = item.status;
        const text = String(raw || 'none');

        if (text.startsWith('HTTP_')) return text;
        if (text === 'NETWORK_ERROR') return 'NETWORK_ERROR';

        return 'HTTP_' + text;
    }

    function miniHttpPathV0424(item) {
        if (!item) return 'none';

        return String(
            item.safePath ||
            item.url ||
            item.path ||
            'none'
        ).replace(/^(local|external):/, '');
    }

    function miniStatusV0424() {
        const gen = miniGenV0424();
        const item = miniLatestHttpV0424();

        if (gen && gen.stopped) {
            return '⏹ 用户手动停止';
        }

        if (miniGenCompletedV0424(gen)) {
            if (item && item.category === 'background') {
                return '✅ 生成正常，后台提示';
            }

            return '✅ 生成正常';
        }

        if (item && item.category === 'generation') {
            return '❌ 生成请求失败';
        }

        try {
            const health = linkHealth();
            const status = String(health && health.status || '');

            if (status === 'Healthy') return '✅ 生成正常';
            if (status === 'User Stopped') return '⏹ 用户手动停止';
            if (status === 'Healthy with Background Notice') return '✅ 生成正常，后台提示';
            if (status === 'Healthy with transient network notice') return '✅ 生成正常，短暂网络提示';
            if (status === 'Generation HTTP Error') return '❌ 生成请求失败';
            if (status === 'Incomplete') return '⚠ 尚未捕获完整生成';

            return status || 'unknown';
        } catch {
            return 'unknown';
        }
    }

    function miniHttpV0424() {
        const gen = miniGenV0424();
        const item = miniLatestHttpV0424();

        if (!item) {
            return '无';
        }

        if (gen && gen.stopped) {
            return '无（用户手动停止）';
        }

        if (miniGenCompletedV0424(gen) && item.category === 'generation') {
            return '无（最近生成已正常完成）';
        }

        if (item.category === 'background') {
            return '后台提示：' + miniHttpStatusV0424(item) + ' / ' + miniHttpPathV0424(item);
        }

        return miniHttpStatusV0424(item) + ' / ' + miniHttpPathV0424(item);
    }

    function miniSuggestionV0424() {
        const gen = miniGenV0424();
        const item = miniLatestHttpV0424();

        if (gen && gen.stopped) {
            return '最近一次是用户手动停止：回复不完整通常不应归因于模型、API 或服务商故障。';
        }

        if (miniGenCompletedV0424(gen)) {
            if (item && item.category === 'background') {
                return '生成本身正常；后台扩展/version 检查失败通常可忽略，需要更新插件时再检查 GitHub 网络。';
            }

            try {
                if (typeof streamModeSnapshotV0412 === 'function') {
                    const sm = streamModeSnapshotV0412();
                    const type = String(sm && (sm.type || sm.mode) || '');

                    if (type.includes('buffered')) {
                        return '生成正常；流式表现为粗粒度缓冲/假流式，这通常是上游或适配器输出形态，不一定是故障。';
                    }
                }
            } catch {}

            return '生成链路正常；若仍觉得慢，优先看首 chunk 延迟、上下文长度、世界书占用和节点质量。';
        }

        if (item && item.category === 'generation') {
            try {
                if (typeof communityActionSuggestionV0413 === 'function') {
                    return communityActionSuggestionV0413();
                }
            } catch {}

            return '生成请求失败：根据状态码、服务商规则和上游日志继续排查。';
        }

        return '信息不足；需要深度排错时请复制完整报告。';
    }


    function buildMiniCommunityReportV0421() {
        let snap = {};

        try {
            snap = getSnapshot();
        } catch {
            snap = {};
        }

        const prompt = miniPromptV0423();

        return [
            'ST 社区超简报',
            '',
            '模型：' + miniValueV0421(snap.model),
            '预设：' + miniPresetV0422(snap),
            '接口：' + miniCleanProviderV0421(),
            '状态：' + miniStatusV0424(),
            'HTTP：' + miniHttpV0424(),
            '流式：' + miniStreamV0423(),
            'Prompt：' + prompt.total,
            '压力：' + prompt.pressure,
            '建议：' + miniSuggestionV0424(),
            '',
            '隐私：未包含正文、prompt、API key、headers、body、query。'
        ].join('\n');
    }

    function copyTextV0421(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text);
        }

        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.left = '-9999px';
        document.body.appendChild(area);
        area.focus();
        area.select();

        try {
            document.execCommand('copy');
        } finally {
            area.remove();
        }

        return Promise.resolve();
    }

    function copyMiniCommunityReportV0421() {
        const text = buildMiniCommunityReportV0421();

        copyTextV0421(text)
            .then(() => {
                try {
                    addEvent('MINI_COMMUNITY_REPORT_COPIED');
                } catch {}
                alert('已复制社区超简报。');
            })
            .catch(err => {
                alert('复制失败：' + (err && err.message ? err.message : err));
            });
    }

    function mountMiniCommunityReportPanelV0421() {
        const panel =
            document.getElementById('stdh4c-panel') ||
            document.querySelector('[id$="-panel"]');

        if (!panel) return;

        let box = document.getElementById('stdh4c-mini-report-box');

        if (!box) {
            box = document.createElement('div');
            box.id = 'stdh4c-mini-report-box';
            box.style.border = '1px solid rgba(80,180,255,0.55)';
            box.style.borderRadius = '10px';
            box.style.padding = '10px';
            box.style.margin = '10px 0';
            box.style.background = 'rgba(0,30,55,0.35)';
            box.style.fontSize = '14px';
            box.style.lineHeight = '1.6';

            box.innerHTML = `
                <div style="font-weight:700;color:#55c7ff;margin-bottom:6px;">
                    社区超简报 / Mini Community Report
                </div>
                <div style="opacity:.75;margin-bottom:8px;font-size:12px;">
                    只包含模型、接口、状态、HTTP、流式、Prompt压力和建议动作。
                </div>
                <button id="stdh4c-copy-mini-report" type="button">
                    复制超简报
                </button>
            `;

            const providerBox = document.getElementById('stdh4c-manual-provider-box');
            if (providerBox && providerBox.parentNode) {
                providerBox.parentNode.insertBefore(box, providerBox);
            } else {
                const hr = panel.querySelector('hr');
                if (hr && hr.parentNode) {
                    hr.parentNode.insertBefore(box, hr.nextSibling);
                } else {
                    panel.appendChild(box);
                }
            }

            const btn = box.querySelector('#stdh4c-copy-mini-report');
            if (btn) {
                btn.onclick = ev => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    copyMiniCommunityReportV0421();
                };
            }
        }
    }


    function boot() {
        setTimeout(stdh4cMountAddonPanelsV0418, 1500);
        setInterval(stdh4cMountAddonPanelsV0418, 3500);






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
            if (localStorage.getItem('stdh4c.devMode') === '1') mountHttpSimPanel();
            mountTokenLensPanel();
            render();
            renderTokenLensUI();
        }, 1200);

        refreshItemizedLensCache();

        setInterval(() => {
            normalizeStopState('itemized-refresh');
            refreshItemizedLensCache();
        }, 2500);

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
