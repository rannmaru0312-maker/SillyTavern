import { eventSource, event_types } from '../../../events.js';
import { getContext } from '../../../extensions.js';
import { detectMemoryCandidate } from './candidate-rules.js';

// A copied/imported card may retain another card's memory ID. Do not guess
// its owner or silently rewrite IDs: that would reassign existing memories.
function getUniqueMemoryCharacterId(context) {
    if (!Array.isArray(context?.characters) ||
        (context.groupId !== undefined && context.groupId !== null && context.groupId !== '')) {
        return null;
    }

    const selected = context.characterId;
    if ((typeof selected !== 'number' && typeof selected !== 'string') ||
        !/^\d+$/.test(String(selected)) || !Number.isSafeInteger(Number(selected))) {
        return null;
    }

    const characterId = context.characters[selected]?.data?.extensions?.miya_memory_id;
    if (typeof characterId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(characterId)) {
        return null;
    }

    const owners = context.characters.filter(character =>
        character?.data?.extensions?.miya_memory_id === characterId,
    );
    return owners.length === 1 ? characterId : null;
}

// 会話イベントと本文取得の確認用。記憶データは変更しない
function logLatestMessage(eventLabel) {
    try {
        const context = getContext();
        const chat = context?.chat;

        if (!Array.isArray(chat) || chat.length === 0) {
            console.log(`[MIYA Memory] ${eventLabel}: 会話履歴がありません`);
            return;
        }

        const latest = chat[chat.length - 1];
        const text = typeof latest?.mes === 'string' ? latest.mes : '';

        console.log(`[MIYA Memory] ${eventLabel}: メッセージ検知`, {
            role: latest?.is_user ? 'user' : 'character',
            hasText: text.length > 0
        });
    } catch (error) {
        console.error('[MIYA Memory] 本文取得テスト失敗:', error);
    }
}

eventSource.on(event_types.MESSAGE_SENT, (messageIndex) => {
    try {
        const chat = getContext()?.chat;

        if (!Array.isArray(chat) ||
            !Number.isInteger(messageIndex) ||
            messageIndex < 0 ||
            messageIndex >= chat.length) {
            return;
        }

        const message = chat[messageIndex];

        if (!message?.is_user ||
            typeof message.mes !== 'string' ||
            !message.mes.trim()) {
            return;
        }

        const candidate = detectMemoryCandidate(message.mes);

        console.log('[MIYA Memory] 記憶候補判定', {
            messageIndex,
            detected: candidate !== null,
            reason: candidate?.reason || null
        });

        if (candidate) {
            const context = getContext();
            const characterId = getUniqueMemoryCharacterId(context);

            if (!characterId) {
                console.warn('[MIYA Memory] 記憶IDが未設定・不正・重複、または対象が曖昧なため登録を見送りました');
                return;
            }

            void (async () => {
                try {
                    const csrfResponse = await fetch('/csrf-token', {
                        credentials: 'same-origin'
                    });

                    if (!csrfResponse.ok) {
                        throw new Error('CSRFトークン取得失敗');
                    }

                    const { token } = await csrfResponse.json();

                    // Recheck after the await: cards may have been imported,
                    // edited, or switched while the CSRF request was pending.
                    if (getUniqueMemoryCharacterId(getContext()) !== characterId) {
                        console.warn('[MIYA Memory] 記憶の登録先が変わったため登録を見送りました');
                        return;
                    }

                    const response = await fetch('/api/plugins/miya-memory/candidate-v3', {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-CSRF-Token': token
                        },
                        body: JSON.stringify({
                            characterId,
                            text: candidate.text,
                            reason: candidate.reason
                        })
                    });

                    if (response.status === 409) {
                        console.log('[MIYA Memory] 重複候補のため登録を見送りました');
                        return;
                    }

                    if (!response.ok) {
                        throw new Error('登録APIエラー: ' + response.status);
                    }

                    console.log('[MIYA Memory] 記憶候補を承認待ちに登録しました');
                } catch (error) {
                    console.error('[MIYA Memory] 記憶候補の登録失敗:', error);
                }
            })();
        }
    } catch (error) {
        console.error('[MIYA Memory] メッセージ取得失敗:', error);
    }
});

eventSource.on(event_types.MESSAGE_RECEIVED, () => {
    logLatestMessage('AIメッセージ');
});

(async function () {
    const oldPanel = document.getElementById('miya-memory-panel');
    if (oldPanel) oldPanel.remove();

    const panel = document.createElement('div');
    panel.id = 'miya-memory-panel';

    const title = document.createElement('h3');
    title.textContent = 'MIYA & KOHARU 記憶管理';
　　    // 記憶管理パネルをタイトルのドラッグで移動する
    title.style.cursor = 'move';
    title.style.userSelect = 'none';
    title.style.touchAction = 'none';

    const positionKey = 'miya-memory-panel-position';
    const sizeKey = 'miya-memory-panel-size';

    // パソコンで保存したウィンドウサイズを復元
    try {
        const savedSize = JSON.parse(localStorage.getItem(sizeKey));

        if (
            window.innerWidth > 768 &&
            Number.isFinite(savedSize?.width) &&
            Number.isFinite(savedSize?.height)
        ) {
            panel.style.width = Math.max(
                220, Math.min(savedSize.width, window.innerWidth - 20)
            ) + 'px';

            panel.style.height = Math.max(
                100, Math.min(savedSize.height, window.innerHeight - 20)
            ) + 'px';
        }
    } catch (error) {
        console.warn('記憶管理パネルのサイズを復元できませんでした', error);
    }

    function movePanel(left, top) {
        const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
        const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);

        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.left = Math.max(0, Math.min(left, maxLeft)) + 'px';
        panel.style.top = Math.max(0, Math.min(top, maxTop)) + 'px';
    }

    try {
        const saved = JSON.parse(localStorage.getItem(positionKey));
        if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) {
            requestAnimationFrame(() => movePanel(saved.left, saved.top));
        }
    } catch (error) {
        console.warn('記憶管理パネルの位置を復元できませんでした', error);
    }

    let dragStart = null;

    title.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;

        const rect = panel.getBoundingClientRect();
        dragStart = {
            x: event.clientX,
            y: event.clientY,
            left: rect.left,
            top: rect.top,
        };

        title.setPointerCapture(event.pointerId);
    });

    title.addEventListener('pointermove', (event) => {
        if (!dragStart) return;

        movePanel(
            dragStart.left + event.clientX - dragStart.x,
            dragStart.top + event.clientY - dragStart.y
        );
    });

    function finishDrag() {
        if (!dragStart) return;
        dragStart = null;

        try {
            const rect = panel.getBoundingClientRect();
            localStorage.setItem(positionKey, JSON.stringify({
                left: rect.left,
                top: rect.top,
            }));
        } catch (error) {
            console.warn('記憶管理パネルの位置を保存できませんでした', error);
        }
    }

    title.addEventListener('pointerup', finishDrag);
    title.addEventListener('pointercancel', finishDrag);
　　    // 画面サイズが変わったらパネルを表示範囲内に戻す
    window.addEventListener('resize', () => {
        const rect = panel.getBoundingClientRect();

        movePanel(rect.left, rect.top);
    });

    // パソコンで手動変更したウィンドウサイズだけを保存
    let lastInlineSize = {
        width: panel.style.width,
        height: panel.style.height,
    };

    const sizeObserver = new ResizeObserver(() => {
        if (window.innerWidth <= 768) return;

        const widthStyle = panel.style.width;
        const heightStyle = panel.style.height;

        // CSSによる自動的な高さの変化は保存しない
        if (!widthStyle || !heightStyle) return;

        if (
            lastInlineSize.width === widthStyle &&
            lastInlineSize.height === heightStyle
        ) return;

        lastInlineSize = {
            width: widthStyle,
            height: heightStyle,
        };

        const width = parseFloat(widthStyle);
        const height = parseFloat(heightStyle);

        if (!Number.isFinite(width) || !Number.isFinite(height)) return;

        try {
            localStorage.setItem(sizeKey, JSON.stringify({ width, height }));
        } catch (error) {
            console.warn('記憶管理パネルのサイズを保存できませんでした', error);
        }
    });

    sizeObserver.observe(panel);

    const message = document.createElement('p');
    message.textContent = '記憶候補';

    const list = document.createElement('ul');

    const toggleButton = document.createElement('button');
    toggleButton.textContent = '▶ 記憶管理';
    toggleButton.type = 'button';
    toggleButton.setAttribute('aria-expanded', 'false');
　　    // 記憶管理パネルの位置を初期状態に戻す
    const resetButton = document.createElement('button');
    resetButton.textContent = '位置をリセット';
    resetButton.type = 'button';

    resetButton.addEventListener('click', () => {
        localStorage.removeItem(positionKey);

        panel.style.left = 'auto';
        panel.style.right = '8px';
        panel.style.top = '80px';
        panel.style.bottom = 'auto';
    });

    const content = document.createElement('div');
    content.id = 'miya-memory-panel-content';
    content.hidden = true;
    content.append(message, list);

    toggleButton.addEventListener('click', () => {
        const isOpen = content.hidden;
        content.hidden = !isOpen;
        toggleButton.textContent = isOpen
            ? '▼ 記憶管理'
            : '▶ 記憶管理';
        toggleButton.setAttribute('aria-expanded', String(isOpen));
    });

        panel.append(title, toggleButton, resetButton, content);
    document.body.appendChild(panel);

    // MIYA_INLINE_MEMORY_LAYOUT
    // スタート画面ではバナーの下、チャット中は従来の位置へ
    function updateMemoryPanelLocation() {
        const banner = document.getElementById('miya-welcome-banner');
        const welcome = banner?.closest('.welcomePanel');

        if (welcome) {
            if (panel.previousElementSibling !== banner) {
                banner.insertAdjacentElement('afterend', panel);
            }
            panel.classList.add('miya-inline');
        } else {
            panel.classList.remove('miya-inline');
            if (panel.parentElement !== document.body) {
                document.body.appendChild(panel);
            }
        }
    }

    const memoryChat = document.getElementById('chat');
    if (memoryChat) {
        const memoryLayoutObserver = new MutationObserver(updateMemoryPanelLocation);
        memoryLayoutObserver.observe(memoryChat, {
            childList: true,
            subtree: true
        });
    }
    updateMemoryPanelLocation();


    // キャラクター編集画面の下部にチャットへ戻るボタンを追加
    const characterEditor = document.getElementById('rm_ch_create_block');

    if (characterEditor && !document.getElementById('miya-return-to-chat')) {
        const returnButton = document.createElement('button');
        returnButton.id = 'miya-return-to-chat';
        returnButton.type = 'button';
        returnButton.textContent = '💬 チャットへ戻る';

        returnButton.style.cssText = [
            'display:block',
            'width:calc(100% - 20px)',
            'margin:18px auto',
            'padding:13px',
            'background:#467c96',
            'color:white',
            'border:0',
            'border-radius:9px',
            'font-size:16px',
            'font-weight:bold',
            'cursor:pointer'
        ].join(';');

        returnButton.addEventListener('click', () => {
            const drawerIcon = document.getElementById('rightNavDrawerIcon');
            if (drawerIcon?.classList.contains('openIcon')) {
                drawerIcon.click();
            }
        });

        const avatarBlock = characterEditor.querySelector('#avatar-and-name-block');

        if (avatarBlock) {
            avatarBlock.after(returnButton);
        } else {
            characterEditor.appendChild(returnButton);
        }
    }


    async function saveDecision(candidate, decision) {
        const tokenResponse = await fetch('/csrf-token');

        if (!tokenResponse.ok) {
            throw new Error('CSRFトークン取得失敗');
        }

        const { token } = await tokenResponse.json();

        const response = await fetch('/api/plugins/miya-memory/decision-v3', {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': token,
            },
            body: JSON.stringify({ candidateId: candidate, decision }),
        });

        if (!response.ok) {
            if (response.status === 409) {
                throw new Error('この候補は既に処理済みです');
            }
            throw new Error('保存失敗（HTTP ' + response.status + '）');
        }

        const result = await response.json();

        if (result.success !== true) {
            throw new Error('保存結果を確認できませんでした');
        }

        return result;
    }

    try {
        const response = await fetch('/api/plugins/miya-memory/decisions-v3', { credentials: 'same-origin' });

        if (!response.ok) {
            throw new Error('HTTP ' + response.status);
        }

        const data = await response.json();

        if (!Array.isArray(data.pending)) {
            throw new Error('記憶候補の形式が正しくありません');
        }

        const decisionsResponse = await fetch('/api/plugins/miya-memory/decisions-v3', { credentials: 'same-origin' });

        if (!decisionsResponse.ok) {
            throw new Error('保存済み判定の取得失敗（HTTP ' + decisionsResponse.status + '）');
        }

        const decisionsData = await decisionsResponse.json();

        if (!Array.isArray(decisionsData.decisions)) {
            throw new Error('保存済み判定の形式が正しくありません');
        }

        const savedDecisions = new Map(
            decisionsData.decisions.map(item => [item.candidateId, item.decision])
        );


        // MIYA_MEMORY_COUNTERS_V1
        // 保留中も100件の登録枠を使用する
        function displayMemoryCounters(current) {
            const entries = current.pending.filter(
                item => item.status === 'pending'
            );

            const decidedIds = new Set(
                current.decisions
                    .filter(item =>
                        item.decision === 'approve' ||
                        item.decision === 'hold'
                    )
                    .map(item => item.candidateId)
            );

            const used = entries.length;
            const untreated = entries.filter(
                item => !decidedIds.has(item.id)
            ).length;

            message.textContent =
                `候補枠使用：${used} / 100件｜` +
                `未処理：${untreated}件｜` +
                `登録可能：${Math.max(0, 100 - used)}件` +
                (used === 0 ? '｜記憶候補はありません' : '');
        }

        async function refreshMemoryCounters() {
            try {
                const response = await fetch(
                    '/api/plugins/miya-memory/decisions-v3',
                    { credentials: 'same-origin' }
                );
                if (!response.ok) throw new Error('HTTP ' + response.status);

                const current = await response.json();
                if (!Array.isArray(current.pending) ||
                    !Array.isArray(current.decisions)) {
                    throw new Error('件数データの形式が不正です');
                }

                displayMemoryCounters(current);
            } catch (error) {
                console.error('[MIYA Memory] 件数更新失敗:', error);
                message.textContent = '件数を更新できませんでした';
            }
        }

        displayMemoryCounters(data);

        for (const memory of data.pending) {
            if (savedDecisions.get(memory.id) === 'approve') continue;

            const item = document.createElement('li');

            const text = document.createElement('div');
            text.textContent = memory.text;

            const reason = document.createElement('div');
            reason.textContent = '判定理由：' + memory.reason;

            const approveButton = document.createElement('button');
            approveButton.textContent = '承認';

            const holdButton = document.createElement('button');
            holdButton.textContent = '保留';

            const status = document.createElement('div');
            const savedDecision = savedDecisions.get(memory.id);

            if (savedDecision === 'approve' || savedDecision === 'hold') {
                status.textContent = savedDecision === 'approve'
                    ? '承認済み（テスト保存）'
                    : '保留中';

                approveButton.disabled = savedDecision === "approve";
                holdButton.disabled = true;
            } else {
                status.textContent = memory.status === 'pending' ? '承認待ち' : memory.status;
            }

            async function handleDecision(decision) {
                approveButton.disabled = true;
                holdButton.disabled = true;
                status.textContent = '保存中...';

                try {
                    await saveDecision(memory.id, decision);
                    void refreshMemoryCounters();

                    if (decision === 'approve') {
                        item.remove();
                    } else {
                        status.textContent = '保留中';
                        approveButton.disabled = false;
                        holdButton.disabled = true;
                    }
                } catch (error) {
                    status.textContent = 'エラー：' + error.message;
                    approveButton.disabled = false;
                    holdButton.disabled = savedDecision === "hold";
                    console.error('記憶保存エラー：', error);
                }
            }

            approveButton.addEventListener('click', () => handleDecision('approve'));
            holdButton.addEventListener('click', () => handleDecision('hold'));

            item.append(text, reason, approveButton, holdButton, status);
            list.appendChild(item);
        }



        console.log('MIYA & KOHARU 記憶管理：保存API接続準備完了');
    } catch (error) {
        message.textContent = '記憶候補の読み込みに失敗しました';
        console.error('MIYA & KOHARU 記憶管理：', error);
    }
})();
