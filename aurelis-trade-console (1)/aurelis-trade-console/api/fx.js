// GET /api/fx
// 한국수출입은행 "현재환율 API"(AP01)를 최근 영업일 여러 날짜로 불러와,
// 사이트가 바로 그릴 수 있는 형태로 정리해 돌려줍니다.
//
// 필요한 환경 변수: KOREAEXIM_API_KEY  (한국수출입은행 오픈API 인증키)
// 선택 환경 변수:   FX_DAYS (기본 45, 불러올 달력 일수. 주말은 자동으로 건너뜀)
//
// 수출입은행 API 특징
//  - 하루 1,000회까지 호출 가능. 이 코드는 결과를 12시간 캐시하므로 하루 수십 회만 씁니다.
//  - 영업일 오전 11시경 그날 환율이 올라옵니다. 주말·공휴일·11시 이전에는 빈 결과가 옵니다.
//  - 숫자가 "1,386.4"처럼 쉼표가 들어간 문자열로 옵니다.

import { sendJSON, cached, kstDate, fetchWithTimeout } from '../lib/util.js';

const ENDPOINT = 'https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON';

// 수출입은행 통화 코드 → 사이트에서 쓰는 코드
const WANT = { 'USD': 'USD', 'EUR': 'EUR', 'JPY(100)': 'JPY100', 'CNH': 'CNY', 'SAR': 'SAR', 'GBP': 'GBP', 'AED': 'AED', 'SGD': 'SGD' };

const RESULT_MESSAGE = {
  2: '요청 데이터 코드(data=AP01)가 잘못되었습니다.',
  3: '인증키가 올바르지 않습니다. .env의 KOREAEXIM_API_KEY를 확인하세요.',
  4: '오늘 호출 한도(1,000회)를 넘었습니다. 내일 다시 시도하세요.',
};

/** 수출입은행 서버는 쿠키를 붙여 리다이렉트하는 경우가 있어, 쿠키를 들고 직접 따라갑니다. */
async function getJSON(url) {
  let cookie = '';
  for (let i = 0; i < 5; i++) {
    const res = await fetchWithTimeout(url, { redirect: 'manual', headers: cookie ? { cookie } : {} });
    if (res.status >= 300 && res.status < 400) {
      const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
      if (set.length) cookie = set.map(c => c.split(';')[0]).join('; ');
      const loc = res.headers.get('location');
      if (!loc) break;
      url = new URL(loc, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`수출입은행 응답 오류 (HTTP ${res.status})`);
    const text = await res.text();
    return text.trim() ? JSON.parse(text) : [];
  }
  throw new Error('수출입은행 서버가 리다이렉트를 반복합니다.');
}

const num = v => (v == null || v === '' ? null : Number(String(v).replace(/,/g, '')));

/** 최근 영업일 날짜 목록 (YYYYMMDD), 오래된 날 → 최근 순 */
function businessDays(calendarDays) {
  const out = [];
  const today = new Date(kstDate() + 'T00:00:00Z');
  for (let i = calendarDays - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 864e5);
    const w = d.getUTCDay();
    if (w === 0 || w === 6) continue;
    out.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  return out;
}

async function loadRates(key, days) {
  const dates = businessDays(days);
  const byDate = {};
  // 동시에 4개씩만 호출해 서버에 부담을 주지 않습니다.
  for (let i = 0; i < dates.length; i += 4) {
    const chunk = dates.slice(i, i + 4);
    const results = await Promise.all(chunk.map(async d => {
      const url = `${ENDPOINT}?authkey=${encodeURIComponent(key)}&searchdate=${d}&data=AP01`;
      try { return [d, await getJSON(url)]; } catch (e) { return [d, { error: e.message }]; }
    }));
    for (const [d, rows] of results) byDate[d] = rows;
  }

  // 인증키 오류 등은 모든 날짜에서 똑같이 나오므로 바로 알려 줍니다.
  const sample = Object.values(byDate).find(r => Array.isArray(r) && r.length);
  const code = sample && (sample[0].result ?? sample[0].RESULT);
  if (code && code !== 1 && RESULT_MESSAGE[code]) throw new Error(RESULT_MESSAGE[code]);
  if (!sample) {
    const err = Object.values(byDate).find(r => r && r.error);
    throw new Error(err ? err.error : '최근 환율 데이터를 찾지 못했습니다.');
  }

  const series = {};
  for (const d of dates) {
    const rows = byDate[d];
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      const unit = r.cur_unit ?? r.CUR_UNIT;
      const code = WANT[unit];
      const rate = num(r.deal_bas_r ?? r.DEAL_BAS_R);
      if (!code || !rate) continue;
      (series[code] ||= { code, name: r.cur_nm ?? r.CUR_NM ?? code, history: [], dates: [] });
      series[code].history.push(rate);
      series[code].dates.push(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`);
    }
  }
  const rates = Object.values(series).map(s => ({ ...s, rate: s.history[s.history.length - 1] }));
  const last = rates[0]?.dates.at(-1) ?? null;
  return { date: last, source: 'koreaexim', rates };
}

export default async function handler(req, res) {
  const key = process.env.KOREAEXIM_API_KEY;
  if (!key) return sendJSON(res, 500, { error: 'KOREAEXIM_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.' });
  const days = Math.min(Math.max(Number(process.env.FX_DAYS) || 45, 7), 120);
  try {
    const data = await cached(`fx:${days}:${kstDate()}`, 12 * 3600e3, () => loadRates(key, days));
    sendJSON(res, 200, data, 12 * 3600);
  } catch (e) {
    sendJSON(res, 502, { error: e.message });
  }
}
