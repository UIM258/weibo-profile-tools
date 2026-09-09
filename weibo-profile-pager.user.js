// ==UserScript==
// @name         微博个人主页分页浏览
// @name:zh-CN   微博个人主页分页浏览
// @namespace    https://github.com/your-name/weibo-profile-pager
// @version      1.0.0
// @icon         https://weibo.com/favicon.ico
// @description  微博个人主页(u/xxx)信息流分页浏览：上一页/下一页/页码跳转/一键直达最早；支持暗色模式、点击图片灯箱预览、自动缓存，快速回看早期微博
// @description:zh-CN  微博个人主页(u/xxx)信息流分页浏览：上一页/下一页/页码跳转/一键直达最早；支持暗色模式、点击图片灯箱预览、自动缓存，快速回看早期微博
// @author       you
// @license      MIT
// @match        https://weibo.com/u/*
// @match        https://www.weibo.com/u/*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    var LOG_TAG = '[微博主页分页器]';

    // ============================================================
    // 0. 只在个人主页运行，取出 uid
    // ============================================================
    var m = location.pathname.match(/^\/u\/(\d+)/);
    if (!m) { console.log(LOG_TAG, '不是 weibo.com/u/<uid> 个人主页，退出'); return; }
    var UID = m[1];

    // ============================================================
    // 1. 可调配置
    // ============================================================
    var CONFIG = {
        probeDelay: 400,      // “直达最早”探测时相邻两次请求间隔(ms)，避免触发风控
        maxProbePage: 8192,   // 探测上限：最多翻到第几页
        requestTimeout: 15000 // 单次请求超时
    };

    // ============================================================
    // 2. 状态
    // ============================================================
    var state = {
        theme: 'auto',   // auto | light | dark
        page: 1,
        loading: false,
        probing: false,
        abortProbe: false,
        cache: new Map(),     // page -> { list, fetchedAt }
        earliestKnown: null,   // 探测到的“最早”那一页
    totalHint: null,      // 接口返回的总条数（提示用）
    };

    var SKEY = 'wpp_cache_' + UID;
    var MKEY = 'wpp_meta_' + UID;

    // ============================================================
    // 3. 小工具
    // ============================================================
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function getCookie(name) {
        var parts = document.cookie.split(';');
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i].trim();
            if (p.indexOf(name + '=') === 0) return decodeURIComponent(p.slice(name.length + 1));
        }
        return '';
    }

    var MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

    // 解析微博时间 "Tue Sep 09 12:00:00 +0800 2025"
    function parseWeiboTime(s) {
        if (!s) return null;
        var mm = String(s).match(/^(\w{3})\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+([+-]\d{4})\s+(\d{4})$/);
        if (!mm) { var d = new Date(s); return isNaN(d.getTime()) ? null : d; }
        var mon = MONTHS[mm[2]];
        if (mon === undefined) return null;
        var tz = mm[7];
        var tzMin = (parseInt(tz.slice(1, 3), 10) * 60 + parseInt(tz.slice(3, 5), 10)) * (tz[0] === '-' ? -1 : 1);
        return new Date(Date.UTC(+mm[8], mon, +mm[3], +mm[4], +mm[5], +mm[6]) - tzMin * 60000);
    }

    function pad(n) { return String(n).padStart(2, '0'); }

    function fmtTime(d) {
        if (!d || isNaN(d.getTime())) return '';
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function fmtCount(v) {
        var n = Number(v) || 0;
        if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
        if (n >= 10000) return (n / 10000).toFixed(1) + '万';
        return String(n);
    }

    // 微博 text 是 HTML，剥掉危险标签后原样展示（内容来自微博自家接口，同源可信）
    function textFragment(html) {
        var tpl = document.createElement('template');
        tpl.innerHTML = html || '';
        var frag = tpl.content;
        frag.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach(function (n) { n.remove(); });
        frag.querySelectorAll('a').forEach(function (a) {
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            if (!a.getAttribute('href')) a.removeAttribute('href');
        });
        frag.querySelectorAll('br').forEach(function (b) {
            // 保留换行（微博正文用 <br> 分行）
        });
        return frag;
    }

    function stripHtml(html) {
        var tpl = document.createElement('template');
        tpl.innerHTML = (html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div)>/gi, '\n');
        return (tpl.content.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    }

    // 提取图片大图地址（尽力而为，取不到也不影响文字浏览）
    // 图片：每条返回 { thumb(缩略图), full(大图) }，列表用 thumb 立即加载，点击用 full 预览
    function getPicPairs(mb) {
        var out = [];
        if (Array.isArray(mb.pic_ids) && mb.pic_infos) {
            mb.pic_ids.forEach(function (pid) {
                var info = mb.pic_infos[pid];
                if (!info) return;
                var thumb = (info.bmiddle && info.bmiddle.url) || (info.thumbnail && info.thumbnail.url) || (info.large && info.large.url) || (info.original && info.original.url);
                var full = (info.largest && info.largest.url) || (info.mw2000 && info.mw2000.url) || (info.original && info.original.url) || (info.large && info.large.url) || thumb;
                if (thumb || full) out.push({ thumb: thumb || full, full: full || thumb });
            });
        } else if (Array.isArray(mb.pics)) {
            mb.pics.forEach(function (p) {
                var full = (p.largest && p.largest.url) || (p.large && p.large.url) || p.url || p.original_pic || p.bmiddle_pic;
                var thumb = (p.bmiddle && p.bmiddle.url) || (p.thumbnail && p.thumbnail.url) || full;
                if (full || thumb) out.push({ thumb: thumb || full, full: full || thumb });
            });
        } else {
            var legacyFull = mb.original_pic || mb.bmiddle_pic || mb.thumbnail_pic;
            var legacyThumb = mb.bmiddle_pic || mb.thumbnail_pic || legacyFull;
            if (legacyFull || legacyThumb) out.push({ thumb: legacyThumb || legacyFull, full: legacyFull || legacyThumb });
        }
        return out;
    }

    // ============================================================
    // 4. 请求微博分页接口
    // ============================================================
    var XSRF = getCookie('XSRF-TOKEN') || getCookie('x-xsrf-token') || '';

    function apiUrl(page) {
        return 'https://weibo.com/ajax/statuses/mymblog?uid=' + UID + '&page=' + page + '&feature=0';
    }

    // remember=true 时写入内存缓存 + sessionStorage；探测时传 false
    function fetchPage(page, remember) {
        remember = remember !== false;
        if (remember && state.cache.has(page)) return Promise.resolve(state.cache.get(page));

        var headers = {
            'x-requested-with': 'XMLHttpRequest',
            'Accept': 'application/json, text/plain, */*'
        };
        if (XSRF) headers['x-xsrf-token'] = XSRF;

        var ctrl = new AbortController();
        var timer = setTimeout(function () { ctrl.abort(); }, CONFIG.requestTimeout);

        return fetch(apiUrl(page), { credentials: 'include', headers: headers, signal: ctrl.signal, cache: 'no-store' })
            .then(function (resp) {
                clearTimeout(timer);
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                return resp.json();
            })
            .then(function (json) {
                if (!json || json.ok !== 1) {
                    var reason = (json && (json.message || json.msg)) || '接口未返回数据';
                    throw new Error('ok=' + (json && json.ok) + ' ' + reason);
                }
                var list = (json.data && Array.isArray(json.data.list)) ? json.data.list : [];
                console.log(LOG_TAG, '第' + page + '页 → ' + list.length + ' 条',
                    list[0] ? { mblogid: list[0].mblogid, created_at: list[0].created_at } : '(空)');
                var entry = { list: list, fetchedAt: Date.now() };
                if (remember && page === 1 && json.data && json.data.total) {
                    state.totalHint = Number(json.data.total);
                    saveMeta();
                }
                if (remember) {
                    state.cache.set(page, entry);
                    saveCache();
                }
                return entry;
            })
            .catch(function (err) {
                clearTimeout(timer);
                if (err && err.name === 'AbortError') throw new Error('请求超时');
                throw err;
            });
    }

    function saveCache() {
        try {
            // 只保留最近 120 页，防止撑爆 sessionStorage
            var pages = Array.from(state.cache.keys()).sort(function (a, b) { return a - b; });
            while (pages.length > 120) { state.cache.delete(pages.shift()); }
            var obj = {};
            state.cache.forEach(function (v, k) { obj[k] = v.list; });
            sessionStorage.setItem(SKEY, JSON.stringify(obj));
        } catch (e) { /* 存不下就算了 */ }
    }

    function loadCache() {
        try {
            var raw = sessionStorage.getItem(SKEY);
            if (!raw) return;
            var obj = JSON.parse(raw);
            Object.keys(obj).forEach(function (k) {
                state.cache.set(Number(k), { list: obj[k], fetchedAt: Date.now() });
            });
        } catch (e) { /* 忽略 */ }
    }

    function saveMeta() {

        try { sessionStorage.setItem(MKEY, JSON.stringify({ earliestKnown: state.earliestKnown, totalHint: state.totalHint })); } catch (e) {}

    }

    

    function loadMeta() {

        try {

            var raw = sessionStorage.getItem(MKEY);

            if (!raw) return;

            var obj = JSON.parse(raw);

            if (obj.earliestKnown) state.earliestKnown = obj.earliestKnown;

            if (obj.totalHint) state.totalHint = obj.totalHint;

        } catch (e) {}

    }


    // ============================================================

    // 5. 渲染
    // ============================================================
    var els = {};   // 界面元素引用
    var overlay = null;

    function detailHref(mb) {
        var authorId = (mb.user && (mb.user.idstr || mb.user.id)) || UID;
        var id = mb.mblogid || mb.id;
        return 'https://weibo.com/' + authorId + '/' + id;
    }

    function buildCard(mb) {
        var card = document.createElement('article');
        card.className = 'wpp-card';

        var user = mb.user || {};
        var avatar = user.avatar_hd || user.avatar_large || user.profile_image_url || '';
        var name = user.screen_name || '(未知用户)';

        // ---- 头部 ----
        var head = document.createElement('div');
        head.className = 'wpp-head';
        if (avatar) {
            var av = document.createElement('img');
            av.className = 'wpp-avatar';
            av.src = avatar;
            av.alt = '';
            head.appendChild(av);
        }
        var meta = document.createElement('div');
        meta.className = 'wpp-meta';
        var nm = document.createElement('div');
        nm.className = 'wpp-name';
        nm.textContent = name;
        meta.appendChild(nm);
        var timeNode = document.createElement('div');
        timeNode.className = 'wpp-time';
        var d = parseWeiboTime(mb.created_at);
        var srcTxt = stripHtml(mb.source || '');
        timeNode.textContent = fmtTime(d) + (srcTxt ? ' · ' + srcTxt : '');
        meta.appendChild(timeNode);
        head.appendChild(meta);
        card.appendChild(head);

        // ---- 正文 ----
        var body = document.createElement('div');
        body.className = 'wpp-text';
        body.appendChild(textFragment(mb.text || ''));
        card.appendChild(body);

        if (mb.isLongText) {
            var lt = document.createElement('div');
            lt.className = 'wpp-hint';
            lt.textContent = '（长微博，完整内容请在微博中打开）';
            card.appendChild(lt);
        }

        // ---- 图片 ----
        var pics = getPicPairs(mb);
        if (pics.length) {
            var grid = document.createElement('div');
            grid.className = 'wpp-grid' + (pics.length === 1 ? ' wpp-grid-1' : '');
            pics.forEach(function (pair, idx) {
                var img = document.createElement('img');
                img.src = pair.thumb;
                img.alt = '';
                img.loading = 'eager';
                img.title = '点击预览大图';
                img.addEventListener('click', function () { openLightbox(pics, idx); });
                grid.appendChild(img);
            });
            card.appendChild(grid);
        }

        // ---- 视频/卡片信息（尽力显示标题并给出原文链接） ----
        if (mb.page_info) {
            var pi = mb.page_info;
            var title = pi.page_title || (pi.media_info && pi.media_info.name) || '';
            if (title) {
                var vb = document.createElement('div');
                vb.className = 'wpp-video';
                vb.textContent = (pi.type === 'video' ? '🎬 ' : '🔗 ') + stripHtml(title);
                card.appendChild(vb);
            }
        }

        // ---- 转发 ----
        if (mb.retweeted_status) {
            var r = mb.retweeted_status;
            var ru = r.user || {};
            var box = document.createElement('div');
            box.className = 'wpp-repost';
            var rh = document.createElement('div');
            rh.className = 'wpp-repost-head';
            rh.textContent = '转发 @' + (ru.screen_name || '(未知)');
            box.appendChild(rh);
            var rt = document.createElement('div');
            rt.className = 'wpp-repost-text';
            rt.appendChild(textFragment(r.text || ''));
            box.appendChild(rt);
            var rpics = getPicPairs(r);
            if (rpics.length) {
                var rrow = document.createElement('div');
                rrow.className = 'wpp-repost-imgs';
                rpics.slice(0, 4).forEach(function (pair, idx) {
                    var img = document.createElement('img');
                    img.src = pair.thumb;
                    img.alt = '';
                    img.loading = 'eager';
                    img.title = '点击预览大图';
                    img.addEventListener('click', function () { openLightbox(rpics, idx); });
                    rrow.appendChild(img);
                });
                box.appendChild(rrow);
            }
            card.appendChild(box);
        }

        // ---- 底部：计数 + 原文 ----
        var foot = document.createElement('div');
        foot.className = 'wpp-foot';
        var counts = document.createElement('span');
        counts.className = 'wpp-counts';
        counts.textContent = '转发 ' + fmtCount(mb.reposts_count) + ' · 评论 ' + fmtCount(mb.comments_count) + ' · 赞 ' + fmtCount(mb.attitudes_count);
        foot.appendChild(counts);
        var link = document.createElement('a');
        link.className = 'wpp-open';
        link.href = detailHref(mb);
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = '在微博打开 ↗';
        foot.appendChild(link);
        card.appendChild(foot);

        return card;
    }

    function renderPage(page) {
        var entry = state.cache.get(page);
        var listEl = els.list;
        listEl.innerHTML = '';
        if (!entry) {
            listEl.appendChild(msgEl('本页没有数据。'));
            return;
        }
        var list = entry.list;
        if (!list.length) {
            listEl.appendChild(msgEl('这一页是空的 —— 可能已经到最早可浏览的内容，或该页被微博限制。'));
            return;
        }
        list.forEach(function (mb) {
            try { listEl.appendChild(buildCard(mb)); }
            catch (e) { console.warn(LOG_TAG, '渲染某条失败', e, mb && mb.mblogid); }
        });
    }

    function msgEl(text) {
        var div = document.createElement('div');
        div.className = 'wpp-msg';
        div.textContent = text;
        return div;
    }

    function setStatus(text, isErr) {
        if (!els.status) return;
        els.status.textContent = text;
        els.status.className = 'wpp-status' + (isErr ? ' wpp-status-err' : '');
    }

    function updateControls() {
        els.pageLabel.textContent = String(state.page);
        els.prev.disabled = state.page <= 1 || state.loading;
        els.pageInput.value = String(state.page);
        var parts = [];
            if (state.totalHint) parts.push('接口统计约 ' + state.totalHint + ' 条');
            if (state.earliestKnown) parts.push('已探测到最早约第 ' + state.earliestKnown + ' 页');
            els.earliestTip.textContent = parts.length ? '（' + parts.join(' · ') + '）' : '';
    }

    function showPage(page) {
        if (state.loading) return;
        if (page < 1) page = 1;
        state.page = page;
        state.loading = true;
        setStatus('正在加载第 ' + page + ' 页…');
        updateControls();
        fetchPage(page, true)
            .then(function (entry) {
                state.loading = false;
                renderPage(page);
                setStatus('第 ' + page + ' 页 · ' + entry.list.length + ' 条'
                    + (entry.list.length ? pageRangeText(entry.list) : ''));
                updateControls();
            })
            .catch(function (err) {
                state.loading = false;
                setStatus('加载失败：' + (err && err.message ? err.message : err) + '（若提示登录，请先正常打开该主页并登录）', true);
                updateControls();
            });
    }

    function pageRangeText(list) {
        var first = parseWeiboTime(list[0].created_at);
        var last = parseWeiboTime(list[list.length - 1].created_at);
        return ' · 时间 ' + fmtTime(first) + ' → ' + fmtTime(last);
    }

    // 上一页 / 下一页（注意：页码越大越早）
    function goPrev() { if (state.page > 1) showPage(state.page - 1); }
    function goNext() { showPage(state.page + 1); }

    // ============================================================
    // 6. “直达最早”：先指数探测再二分，找到最后一个非空页
    // ============================================================
    function setProbeUI(on) {
        state.probing = on;
        els.earliest.textContent = on ? '探测中…点击取消' : '直达最早';
        els.earliest.classList.toggle('wpp-busy', on);
    }

    function probeHas(page) {
        return fetchPage(page, false).then(function (e) { return e.list.length > 0; });
    }

    function findEarliest() {
        if (state.probing) { state.abortProbe = true; return; }
        if (state.loading) return;
        state.abortProbe = false;
        setProbeUI(true);
        setStatus('正在探测最早内容（每隔 ' + CONFIG.probeDelay + 'ms 一次请求，可点按钮取消）…');

        var probe = function (page) {
            if (state.abortProbe) throw new Error('已取消');
            return probeHas(page).then(function (ok) {
                if (state.abortProbe) throw new Error('已取消');
                return ok;
            });
        };

        (function run() {
            var lastGood = 1;
            var firstEmpty = null;
            // 指数探测
            var step = function (p) {
                if (state.abortProbe) { throw new Error('已取消'); }
                if (p > CONFIG.maxProbePage) { firstEmpty = null; return finish(lastGood); }
                setStatus('探测第 ' + p + ' 页…');
                return probe(p)
                    .then(function (ok) {
                        if (ok) {
                            lastGood = p;
                            return sleep(CONFIG.probeDelay).then(function () { return step(p * 2); });
                        } else {
                            firstEmpty = p;
                            return finish(lastGood, firstEmpty);
                        }
                    });
            };
            var finish = function (lo, hi) {
                // lo 有内容；hi 为空页（或 null=没探到底）
                if (hi === null) {
                    state.earliestKnown = null;
                    setProbeUI(false);
                    setStatus('翻了 ' + CONFIG.maxProbePage + ' 页仍有内容，没探到底；TA 的微博非常多，可继续手动翻。', true);
                    updateControls();
                    return;
                }
                // 二分：在 (lo, hi-1] 里找最后一个非空页
                var bin = function (a, b) {
                    if (state.abortProbe) throw new Error('已取消');
                    if (a >= b) return Promise.resolve(a);
                    var mid = Math.ceil((a + b) / 2);
                    setStatus('二分探测第 ' + mid + ' 页…');
                    return probe(mid).then(function (ok) {
                        if (ok) return bin(mid, b);
                        return bin(a, mid - 1);
                    });
                };
                var searchStart = lastGood + 1;
                var searchEnd = (hi !== null ? hi - 1 : CONFIG.maxProbePage);
                if (searchStart > searchEnd) return Promise.resolve(lastGood);
                return bin(searchStart, searchEnd).then(function (ans) {
                    // ans 是最早非空页
                    state.earliestKnown = ans;
                    saveMeta();
                    setProbeUI(false);
                    setStatus('已定位到最早一页：第 ' + ans + ' 页', false);
                    updateControls();
                    showPage(ans);
                });
            };
            step(1).catch(function (err) {
                setProbeUI(false);
                if (err && err.message === '已取消') setStatus('已取消探测。');
                else setStatus('探测出错：' + (err && err.message ? err.message : err), true);
                updateControls();
            });
        })();
    }

    // ============================================================
    // 7. UI 构建
    // ============================================================
    GM_addStyle(`
        #wpp-launcher {
            position: fixed; right: 18px; bottom: 90px; z-index: 2147483000;
            padding: 10px 14px; border: none; border-radius: 999px; cursor: pointer;
            background: #ff8200; color: #fff; font-size: 14px; font-weight: 600;
            box-shadow: 0 4px 14px rgba(0,0,0,.25);
        }
        #wpp-overlay {
            position: fixed; inset: 0; z-index: 2147483100; display: none;
            background: rgba(20,20,20,.5); font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
        }
        #wpp-overlay.wpp-open { display: flex; align-items: center; justify-content: center; }
        #wpp-panel {
            position: relative;
            display: flex; flex-direction: column;
            width: min(860px, 94vw); height: 88vh; background: #fff; border-radius: 14px;
            box-shadow: 0 12px 50px rgba(0,0,0,.35); overflow: hidden;
        }
        #wpp-bar {
            display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
            padding: 12px 16px; background: #fafafa; border-bottom: 1px solid #eee;
        }
        #wpp-bar button {
            border: 1px solid #d9d9d9; background: #fff; border-radius: 6px;
            padding: 6px 10px; font-size: 13px; cursor: pointer; color: #333;
        }
        #wpp-bar button:hover:not(:disabled) { background: #fff4e6; border-color: #ff8200; color: #ff8200; }
        #wpp-bar button:disabled { opacity: .45; cursor: not-allowed; }
        #wpp-bar button.wpp-busy { background: #ffe3c4; border-color: #ff8200; }
        #wpp-page-now { font-size: 14px; font-weight: 600; margin: 0 2px; min-width: 110px; text-align: center; }
        #wpp-page-input { width: 64px; padding: 5px 6px; border: 1px solid #d9d9d9; border-radius: 6px; font-size: 13px; }
        #wpp-close {
            margin-left: auto; border: none !important; background: transparent !important;
            font-size: 20px; line-height: 1; color: #888; padding: 2px 8px !important;
        }
        #wpp-status {
            padding: 8px 16px; font-size: 12px; color: #888; background: #fff;
            border-bottom: 1px solid #f0f0f0;
        }
        #wpp-status.wpp-status-err { color: #d33; }
        #wpp-list { flex: 1; overflow-y: auto; padding: 12px 16px; background: #f5f5f5; }
        .wpp-card {
            background: #fff; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px;
            border: 1px solid #eee;
        }
        .wpp-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
        .wpp-avatar { width: 42px; height: 42px; border-radius: 50%; object-fit: cover; }
        .wpp-name { font-weight: 600; font-size: 14px; color: #333; }
        .wpp-time { font-size: 12px; color: #999; margin-top: 2px; }
        .wpp-text { font-size: 15px; line-height: 1.7; color: #222; word-break: break-word; }
        .wpp-text a { color: #ff8200; text-decoration: none; }
        .wpp-hint { font-size: 12px; color: #999; margin-top: 4px; }
        .wpp-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: 10px; }
        .wpp-grid-1 { grid-template-columns: 1fr; }
        .wpp-grid img { width: 100%; height: 200px; object-fit: cover; border-radius: 6px; background: #eee; cursor: zoom-in; }
        .wpp-grid-1 img { height: auto; max-height: 460px; object-fit: contain; }
        .wpp-video { margin-top: 8px; padding: 8px 10px; background: #f7f7f7; border-radius: 6px; font-size: 13px; color: #555; }
        .wpp-repost { margin-top: 10px; padding: 10px 12px; background: #fafafa; border-radius: 8px; }
        .wpp-repost-head { font-size: 13px; color: #ff8200; margin-bottom: 4px; }
        .wpp-repost-text { font-size: 13px; line-height: 1.6; color: #444; word-break: break-word; }
        .wpp-repost-imgs { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
        .wpp-repost-imgs img { width: 74px; height: 74px; object-fit: cover; border-radius: 4px; }
        .wpp-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 10px;
                     font-size: 12px; color: #999; }
        .wpp-open { color: #ff8200; text-decoration: none; font-size: 13px; }
        .wpp-msg { text-align: center; color: #999; padding: 40px 10px; font-size: 14px; }
        .wpp-earliest-tip { font-size: 12px; color: #999; width: 100%; }
        .wpp-repost-imgs img { cursor: zoom-in; }
        #wpp-lightbox {
            position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
            gap: 8px; background: rgba(0,0,0,.93); z-index: 40;
        }
        #wpp-lightbox.wpp-lb-open { display: flex; }
        #wpp-lb-stage { position: relative; display: flex; align-items: center; justify-content: center; max-width: calc(100% - 140px); max-height: 100%; }
        #wpp-lb-img { max-width: 100%; max-height: calc(88vh - 60px); object-fit: contain; border-radius: 4px; box-shadow: 0 8px 40px rgba(0,0,0,.7); }
        #wpp-lb-counter { position: absolute; bottom: -30px; left: 0; right: 0; text-align: center; color: #ccc; font-size: 12px; }
        #wpp-lb-prev, #wpp-lb-next {
            flex: 0 0 auto; width: 44px; height: 64px; border: none; border-radius: 8px;
            background: rgba(255,255,255,.12); color: #fff; font-size: 28px; cursor: pointer;
        }
        #wpp-lb-prev:hover:not(:disabled), #wpp-lb-next:hover:not(:disabled) { background: rgba(255,255,255,.28); }
        #wpp-lb-prev:disabled, #wpp-lb-next:disabled { opacity: .25; cursor: not-allowed; }
        #wpp-lb-close { position: absolute; top: 8px; right: 12px; border: none; background: transparent; color: #fff; font-size: 28px; cursor: pointer; line-height: 1; padding: 4px; }
        /* ===== 暗色模式（跟随系统，或手动选择） ===== */
        #wpp-overlay.wpp-dark #wpp-panel { background:#1e1e22; color:#e8e8ea; }
        #wpp-overlay.wpp-dark #wpp-bar { background:#17171a; border-bottom-color:#2a2a2f; }
        #wpp-overlay.wpp-dark #wpp-bar button { background:#26262b; border-color:#3a3a40; color:#d6d6da; }
        #wpp-overlay.wpp-dark #wpp-bar button:hover:not(:disabled) { background:#3a2a18; border-color:#ff8200; color:#ffb066; }
        #wpp-overlay.wpp-dark #wpp-bar button.wpp-busy { background:#4a3018; border-color:#ff8200; }
        #wpp-overlay.wpp-dark #wpp-page-now { color:#e8e8ea; }
        #wpp-overlay.wpp-dark #wpp-page-input { background:#26262b; border-color:#3a3a40; color:#e8e8ea; }
        #wpp-overlay.wpp-dark #wpp-close { color:#7a7a80; }
        #wpp-overlay.wpp-dark #wpp-status { background:#17171a; color:#9a9aa0; border-bottom-color:#2a2a2f; }
        #wpp-overlay.wpp-dark #wpp-list { background:#121216; }
        #wpp-overlay.wpp-dark .wpp-card { background:#1e1e22; border-color:#2a2a2f; }
        #wpp-overlay.wpp-dark .wpp-name { color:#e8e8ea; }
        #wpp-overlay.wpp-dark .wpp-time { color:#8a8a90; }
        #wpp-overlay.wpp-dark .wpp-text { color:#d6d6da; }
        #wpp-overlay.wpp-dark .wpp-text a { color:#ffa940; }
        #wpp-overlay.wpp-dark .wpp-hint { color:#8a8a90; }
        #wpp-overlay.wpp-dark .wpp-grid img { background:#26262b; }
        #wpp-overlay.wpp-dark .wpp-video { background:#17171a; color:#a6a6ac; }
        #wpp-overlay.wpp-dark .wpp-repost { background:#17171a; }
        #wpp-overlay.wpp-dark .wpp-repost-head { color:#ffa940; }
        #wpp-overlay.wpp-dark .wpp-repost-text { color:#b8b8be; }
        #wpp-overlay.wpp-dark .wpp-foot { color:#8a8a90; }
        #wpp-overlay.wpp-dark .wpp-open { color:#ffa940; }
        #wpp-overlay.wpp-dark .wpp-msg { color:#8a8a90; }
        #wpp-overlay.wpp-dark .wpp-earliest-tip { color:#8a8a90; }
    `);
    var THEME_KEY = 'wpp_theme';

    function loadTheme() {
        try {
            var v = localStorage.getItem(THEME_KEY);
            if (v === 'light' || v === 'dark' || v === 'auto') state.theme = v;
        } catch (e) {}
    }

    function saveTheme() {
        try { localStorage.setItem(THEME_KEY, state.theme); } catch (e) {}
    }

    function systemDark() {
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    function applyTheme() {
        if (!overlay) return;
        var dark = state.theme === 'dark' || (state.theme === 'auto' && systemDark());
        overlay.classList.toggle('wpp-dark', dark);
        overlay.classList.toggle('wpp-light', state.theme === 'light');
        if (els.theme) {
            els.theme.textContent = state.theme === 'dark' ? '🌙 暗色' : (state.theme === 'light' ? '☀️ 亮色' : '🌓 自动');
        }
    }

    function cycleTheme() {
        state.theme = state.theme === 'auto' ? 'dark' : (state.theme === 'dark' ? 'light' : 'auto');
        saveTheme();
        applyTheme();
    }

    function watchTheme() {
        if (window.matchMedia) {
            window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
                if (state.theme === 'auto') applyTheme();
            });
        }
    }

    // ---- 图片灯箱预览 ----
    var lightbox = null;
    var lbPics = [];
    var lbIndex = 0;

    function lbOpen() {
        return !!lightbox && lightbox.classList.contains('wpp-lb-open');
    }

    function ensureLightbox() {
        if (lightbox) return;
        lightbox = document.createElement('div');
        lightbox.id = 'wpp-lightbox';
        lightbox.innerHTML =
            '<button id="wpp-lb-prev" title="上一张">‹</button>' +
            '<div id="wpp-lb-stage"><img id="wpp-lb-img" alt=""/><div id="wpp-lb-counter"></div></div>' +
            '<button id="wpp-lb-next" title="下一张">›</button>' +
            '<button id="wpp-lb-close" title="关闭 (Esc)">×</button>';
        var panel = document.getElementById('wpp-panel');
        if (panel) panel.appendChild(lightbox);
        lightbox.querySelector('#wpp-lb-prev').addEventListener('click', function (e) { e.stopPropagation(); lbPrev(); });
        lightbox.querySelector('#wpp-lb-next').addEventListener('click', function (e) { e.stopPropagation(); lbNext(); });
        lightbox.querySelector('#wpp-lb-close').addEventListener('click', function (e) { e.stopPropagation(); lbClose(); });
        lightbox.addEventListener('click', function (e) {
            if (e.target === lightbox || e.target.id === 'wpp-lb-stage') lbClose();
        });
    }

    function openLightbox(pics, idx) {
        ensureLightbox();
        lbPics = pics || [];
        lbIndex = (typeof idx === 'number') ? idx : 0;
        if (lbIndex < 0) lbIndex = 0;
        if (lbIndex >= lbPics.length) lbIndex = Math.max(0, lbPics.length - 1);
        lightbox.classList.add('wpp-lb-open');
        lbRender();
    }

    function lbRender() {
        if (!lbPics.length) return;
        var img = document.getElementById('wpp-lb-img');
        var counter = document.getElementById('wpp-lb-counter');
        var prev = document.getElementById('wpp-lb-prev');
        var next = document.getElementById('wpp-lb-next');
        var pair = lbPics[lbIndex];
        img.src = pair.full;
        counter.textContent = (lbIndex + 1) + ' / ' + lbPics.length;
        prev.disabled = lbIndex <= 0;
        next.disabled = lbIndex >= lbPics.length - 1;
    }

    function lbPrev() {
        if (lbIndex > 0) { lbIndex--; lbRender(); }
    }

    function lbNext() {
        if (lbIndex < lbPics.length - 1) { lbIndex++; lbRender(); }
    }

    function lbClose() {
        if (lightbox) {
            lightbox.classList.remove('wpp-lb-open');
            var img = document.getElementById('wpp-lb-img');
            if (img) img.src = '';
        }
    }

    function buildUI() {
        // 悬浮按钮
        var launcher = document.createElement('button');
        launcher.id = 'wpp-launcher';
        launcher.textContent = '分页浏览';
        launcher.addEventListener('click', function () { openOverlay(); });
        document.body.appendChild(launcher);

        // 遮罩
        overlay = document.createElement('div');
        overlay.id = 'wpp-overlay';
        overlay.innerHTML =
            '<div id="wpp-panel">' +
            '  <div id="wpp-bar">' +
            '    <button id="wpp-newest" title="回到最新（第1页）">最新</button>' +
            '    <button id="wpp-prev" title="上一页（更新的内容）">‹ 上一页</button>' +
            '    <span id="wpp-page-now">第 1 页</span>' +
            '    <button id="wpp-next" title="下一页（更早的内容）">下一页 ›</button>' +
            '    <button id="wpp-more" title="一次往后翻 10 页（更早）">+10 页</button>' +
            '    <input id="wpp-page-input" type="number" min="1" value="1" />' +
            '    <button id="wpp-jump">跳转</button>' +
            '    <button id="wpp-earliest" title="自动探测 TA 最早一条微博在哪一页并跳过去">直达最早</button>' +
            '    <button id="wpp-refresh" title="重新加载本页">刷新本页</button>' +
            '    <button id="wpp-theme" title="切换 自动 / 亮色 / 暗色">🌓 自动</button>' +
            '    <button id="wpp-close" title="关闭">×</button>' +
            '    <span id="wpp-earliest-tip" class="wpp-earliest-tip"></span>' +
            '  </div>' +
            '  <div id="wpp-status"></div>' +
            '  <div id="wpp-list"></div>' +
            '</div>';
        document.body.appendChild(overlay);

        els.launcher = launcher;
        els.newest = overlay.querySelector('#wpp-newest');
        els.prev = overlay.querySelector('#wpp-prev');
        els.next = overlay.querySelector('#wpp-next');
        els.more = overlay.querySelector('#wpp-more');
        els.pageInput = overlay.querySelector('#wpp-page-input');
        els.jump = overlay.querySelector('#wpp-jump');
        els.earliest = overlay.querySelector('#wpp-earliest');
        els.earliestTip = overlay.querySelector('#wpp-earliest-tip');
        els.refresh = overlay.querySelector('#wpp-refresh');
        els.theme = overlay.querySelector('#wpp-theme');
        els.close = overlay.querySelector('#wpp-close');
        els.status = overlay.querySelector('#wpp-status');
        els.list = overlay.querySelector('#wpp-list');
        els.pageLabel = overlay.querySelector('#wpp-page-now');

        els.newest.addEventListener('click', function () { showPage(1); });
        els.prev.addEventListener('click', goPrev);
        els.next.addEventListener('click', goNext);
        els.more.addEventListener('click', function () { showPage(state.page + 10); });
        els.jump.addEventListener('click', function () {
            var v = parseInt(els.pageInput.value, 10);
            if (isNaN(v) || v < 1) { setStatus('请输入不小于 1 的页码', true); return; }
            showPage(v);
        });
        els.pageInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') els.jump.click();
        });
        els.earliest.addEventListener('click', findEarliest);
        els.refresh.addEventListener('click', function () {
            state.cache.delete(state.page);
            showPage(state.page);
        });
        els.theme.addEventListener('click', cycleTheme);
        els.close.addEventListener('click', closeOverlay);
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeOverlay();
        });
        document.addEventListener('keydown', function (e) {
            if (!overlay.classList.contains('wpp-open')) return;
            if (lbOpen()) {
                if (e.key === 'Escape') lbClose();
                else if (e.key === 'ArrowLeft') lbPrev();
                else if (e.key === 'ArrowRight') lbNext();
                return;
            }
            if (e.key === 'Escape') closeOverlay();
            else if (e.key === 'ArrowLeft') goPrev();
            else if (e.key === 'ArrowRight') goNext();
        });

        updateControls();
    }

    function openOverlay() {
        if (!overlay) return;
        overlay.classList.add('wpp-open');
        if (!state.cache.has(state.page)) {
            showPage(state.page);
        } else {
            renderPage(state.page);
            setStatus('已加载缓存（共 ' + state.cache.size + ' 页在内存中）');
            updateControls();
        }
    }

    function closeOverlay() {
        if (overlay) overlay.classList.remove('wpp-open');
    }

    // 微博 SPA 可能重建 body 子节点，保险起见定时检查悬浮按钮是否还在
    function keepAlive() {
        setInterval(function () {
            if (!document.getElementById('wpp-launcher') && location.pathname.match(/^\/u\/(\d+)/)) {
                var b = document.createElement('button');
                b.id = 'wpp-launcher';
                b.textContent = '分页浏览';
                b.addEventListener('click', function () { openOverlay(); });
                document.body.appendChild(b);
                els.launcher = b;
            }
        }, 3000);
    }

    // ============================================================
    // 9. 启动
    // ============================================================
    function init() {
        console.log(LOG_TAG, '启动，uid=' + UID, '接口示例: ' + apiUrl(1));
        loadCache();
        loadMeta();
        loadTheme();
        buildUI();
        applyTheme();
        watchTheme();
        keepAlive();

        if (typeof GM_registerMenuCommand === 'function') {
            GM_registerMenuCommand('打开分页浏览', function () { openOverlay(); });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
