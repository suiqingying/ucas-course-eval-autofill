// ==UserScript==
// @name         UCAS 本科课程评估自动填写
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  适配 https://bkkcpj.ucas.ac.cn 的 SPA 评估填写页，自动选择每题最高分并填主观题
// @match        https://bkkcpj.ucas.ac.cn/*
// @run-at       document-idle
// @grant        none
// @author       suiqingying
// ==/UserScript==

(function () {
  'use strict';

  const log = (...args) => console.log('[UCAS]', ...args);
  const state = { running: false, lastRun: 0 };
  const RECHECK_DELAY_MS = 600;
  const MAX_RETRY = 4;
  const RETRY_INTERVAL_MS = 500;
  const BLOCK_AUTO_SUBMIT = true;
  const taFeedbackPool = [
    "助教答疑一直都很及时，也很有耐心，会先把问题拆开，再一步一步带着分析，最后还会确认我有没有真正理解。讲解清晰、重点明确，交流顺畅，整体帮助特别大。",
    "助教认真负责，沟通很顺畅，遇到问题能快速定位关键点，然后给出清晰的思路和改进方向。每次答疑都很到位，学习体验很好。",
    "助教反馈细致，讲解有条理，不只是给答案，而是把思路讲清楚。课后支持也很及时，对作业和疑难点的指导非常有效，整体非常满意。",
    "助教非常耐心，语气温和，解释问题的时候会举小例子帮助理解。即使问题比较基础也会认真回答，感觉被尊重、被帮助。",
    "助教的解答很有条理，会先总结共性问题，再针对细节补充说明。沟通效率高，回应快，整体体验很舒服。",
    "助教在答疑和反馈上都很认真，能抓住关键点，把复杂问题讲得很清楚。每次交流都很有收获，非常感谢。"
  ];
  const courseFeedbackPool = [
    "这门课整体结构很清晰，老师讲解生动而且逻辑性强，内容是从基础一步步铺开的，所以跟起来不费劲。知识点衔接自然，学完以后感觉收获很大。",
    "课堂节奏把握得很好，内容扎实不空泛，老师讲解清楚、例子也很贴切，听课体验很好。整体学习感受非常满意。",
    "课程内容丰富，安排合理，讲授深入浅出，既有整体框架也兼顾细节。学习过程中能明显感觉到思路被梳理清楚了，整体非常满意。",
    "老师讲课很有条理，重点突出，难点也会反复强调并配合例子说明。听完之后概念更清晰，理解更扎实。",
    "课程安排紧凑但不压迫，节奏自然，课堂互动也让人更容易集中。整体学习体验很舒服，收获明显。",
    "这门课的讲授方式很清楚，知识点讲到位，还能把复杂概念讲得通俗易懂。整体感觉很棒，非常感谢老师的用心。"
  ];

  // 等待元素出现（SPA/异步渲染必备）
  function waitForAny(selectors, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const timer = setInterval(() => {
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) {
            clearInterval(timer);
            return resolve(el);
          }
        }
        if (Date.now() - start > timeout) {
          clearInterval(timer);
          reject(new Error('wait timeout: ' + selectors.join(', ')));
        }
      }, 200);
    });
  }

  function getRadioText(radio) {
    const label = radio.closest('label');
    const textEl = label && label.querySelector('.el-radio__label');
    return (radio.value || (textEl && textEl.textContent) || '').trim();
  }

  function getTextScore(text) {
    if (!text) return null;
    const t = text.replace(/\s+/g, '');
    const rules = [
      { re: /非常不满意|非常不符合|非常不同意|很不满意|很不符合|很不同意/, score: -2 },
      { re: /不太满意|不太符合|不太同意|较不满意|较不符合|较不同意/, score: -1 },
      { re: /一般|中等|适中|还行/, score: 0 },
      { re: /非常满意|非常符合|非常同意|非常好|非常推荐|强烈同意|完全同意/, score: 3 },
      { re: /比较满意|比较符合|比较同意|较满意|较符合|较同意|满意|符合|同意/, score: 2 },
      { re: /不会/, score: -1 },
      { re: /会/, score: 1 },
      { re: /无助教/, score: -1 },
      { re: /有助教/, score: 1 }
    ];
    for (const { re, score } of rules) {
      if (re.test(t)) return score;
    }
    return null;
  }

  function groupIsChecked(arr) {
    return arr.some(r => r.checked || r.getAttribute('aria-checked') === 'true');
  }

  // 按组选择每题最高分（Element-UI 默认不带 name）
  function chooseMaxRadioPerGroup() {
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    log('radio 数量:', radios.length);

    if (radios.length === 0) {
      log('页面没有 input[type="radio"]，可能是自定义组件/或还没渲染出来。');
      return 0;
    }

    const groups = [];
    const byName = new Map();

    // 优先按 Element-UI 的 radio-group 分组
    const groupEls = Array.from(document.querySelectorAll('.el-radio-group'));
    for (const el of groupEls) {
      const items = Array.from(el.querySelectorAll('input[type="radio"]'));
      if (items.length) groups.push(items);
    }

    // 兜底：按 name 分组
    for (const r of radios) {
      if (!r.name) continue;
      if (!byName.has(r.name)) byName.set(r.name, []);
      byName.get(r.name).push(r);
    }
    for (const arr of byName.values()) groups.push(arr);

    let clicked = 0;
    let unchecked = 0;
    for (const arr of groups) {
      // 找 value 最大的；若 value 不是数字就用文案打分，否则默认选第一个
      let best = null;
      let bestVal = -Infinity;
      let bestScore = -Infinity;
      let hasNumber = false;
      let hasScore = false;

      for (const r of arr) {
        const v = Number(String(r.value).trim());
        if (!Number.isNaN(v)) {
          hasNumber = true;
          if (v > bestVal) { bestVal = v; best = r; }
        }
        if (!hasNumber) {
          const score = getTextScore(getRadioText(r));
          if (score !== null) {
            hasScore = true;
            if (score > bestScore) { bestScore = score; best = r; }
          }
        }
      }
      if (!hasNumber && !hasScore) best = arr[0];

      if (best && !best.disabled) {
        const target = best.closest('label') || best;
        target.click(); // 触发框架的事件绑定
        best.dispatchEvent(new Event('change', { bubbles: true }));
        clicked++;
      }

      if (!groupIsChecked(arr)) unchecked++;
    }

    log('题目组数:', groups.length, '已点击:', clicked, '未勾选:', unchecked);
    return { clicked, unchecked };
  }

  function retryChooseRadios(attempt) {
    const result = chooseMaxRadioPerGroup();
    if (result.unchecked === 0 || attempt >= MAX_RETRY) return;
    setTimeout(() => retryChooseRadios(attempt + 1), RETRY_INTERVAL_MS);
  }

  // 填写 textarea，并触发 input/change
  function pickAnswerForTextarea(ta) {
    const card = ta.closest('.el-card') || ta.closest('.el-form-item');
    const text = card ? (card.textContent || '') : '';
    if (text.includes('助教')) return pickRandom(taFeedbackPool);
    return pickRandom(courseFeedbackPool);
  }

  function fillTextareas(answers) {
    const textareas = Array.from(document.querySelectorAll('textarea'));
    log('textarea 数量:', textareas.length);

    if (answers.length === 0) return;
    textareas.forEach((ta, i) => {
      const preset = answers[i];
      const value = (typeof preset === 'string' && preset.trim() !== '')
        ? preset
        : pickAnswerForTextarea(ta);
      ta.focus();
      ta.value = value;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  function isFillPage() {
    return location.hash.startsWith('#/myPoll/fill/');
  }

  function pickRandom(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  function buildAnswers(count) {
    if (count <= 0) return [];
    const answers = [];
    for (let i = 0; i < count; i++) answers.push(null);
    return answers;
  }

  function guardAutoSubmit() {
    if (!BLOCK_AUTO_SUBMIT) return;
    const btn = document.querySelector('button.el-button--primary');
    if (!btn || btn.__ucas_guarded) return;
    btn.__ucas_guarded = true;
    btn.addEventListener('click', (e) => {
      if (!e.isTrusted) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);
  }

  async function runOnce() {
    if (!isFillPage()) return;
    const now = Date.now();
    if (state.running || now - state.lastRun < 300) return;
    state.running = true;

    log('检测到填写页:', location.href);

    // 等表单渲染出来（radio 或 textarea 任意一个出现就行）
    await waitForAny(['input[type="radio"]', 'textarea']).catch(e => log(e.message));

    // 自动选最高分（若有延迟渲染，自动重试）
    retryChooseRadios(1);

    // 你可以按需要调整主观题文案（如果有 textarea）
    const beforeCount = document.querySelectorAll('textarea').length;
    const answers = buildAnswers(beforeCount);
    fillTextareas(answers);

    // 聚焦验证码（如果存在）
    const code = document.querySelector('input[name="adminValidateCode"]');
    if (code) code.focus();

    log('本次执行结束');
    setTimeout(() => {
      const afterCount = document.querySelectorAll('textarea').length;
      if (afterCount > beforeCount) fillTextareas(answers);
      guardAutoSubmit();
      state.running = false;
      state.lastRun = Date.now();
    }, RECHECK_DELAY_MS);
  }

  // SPA：hashchange 进入填写页不会刷新，所以要监听路由变化
  window.addEventListener('hashchange', runOnce);

  // 异步渲染：监听 DOM 变化，radio 出现就再跑一次（防止太早执行）
  const mo = new MutationObserver(() => {
    if (isFillPage() && (document.querySelector('input[type="radio"]') || document.querySelector('textarea'))) {
      runOnce();
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // 首次也跑
  log('脚本已加载:', location.href);
  runOnce();
})();
