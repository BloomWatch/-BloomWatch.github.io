/* =========================================================
 * Forecast Manager — NDVI/EVI 30-day prediction (client-only)
 * Dependencies: MapManager, VegetationManager, Utils, Plotly (cdn), tf.js (optional)
 * =======================================================*/
(function (global) {
  const ForecastManager = {
    init() {
      this._bind();
    },

    _bind() {
      const btn = document.getElementById('fc-train');
      const btnClear = document.getElementById('fc-clear');
      if (btn) btn.addEventListener('click', () => this.run());
      if (btnClear) btnClear.addEventListener('click', () => this.clear());
    },

    async run() {
      const stats = document.getElementById('fc-stats');
      const product = document.getElementById('fc-product')?.value || 'MOD13Q1';
      const target = document.getElementById('fc-target')?.value || 'ndvi';
      const years  = Math.max(1, Math.min(8, parseInt(document.getElementById('fc-years')?.value || '3')));
      const epochs = Math.max(20, Math.min(1000, parseInt(document.getElementById('fc-epochs')?.value || '120')));
      const lr     = Math.max(0.001, Math.min(0.1, parseFloat(document.getElementById('fc-lr')?.value || '0.01')));

      if (!global.MapManager || !global.VegetationManager) {
        alert('Forecast requires MapManager and VegetationManager.');
        return;
      }

      stats.textContent = 'Fetching history…';
      const { lat, lng } = MapManager.getCurrentLocation();

      try {
        // 1) 历史 NDVI/EVI（~N 年的 16-day composites）
        const viSeries = await this._fetchVISeries(product, target, lat, lng, years);
        if (!viSeries.length) {
          stats.textContent = 'No VI history for this point.';
          return;
        }

        // 2) POWER 每日天气，聚合到 VI 合成日期
        stats.textContent = 'Fetching weather…';
        const wxByDate = await this._fetchWeatherByDate(viSeries, lat, lng);

        // 3) 特征工程
        stats.textContent = 'Building dataset…';
        const ds = this._buildDataset(viSeries, wxByDate);
        if (ds.x.length < 24) {
          stats.textContent = 'Insufficient samples for training.';
          return;
        }

        // 4) 训练：优先 tf.js，小 MLP；无 tf 则线性回归基线
        stats.textContent = (global.tf ? 'Training TF.js model…' : 'Training linear baseline…');
        const model = await this._trainModel(ds, { epochs, lr });

        // 5) 预测未来 30 天（逐日），天气取近 30 天统计近似
        stats.textContent = 'Forecasting 30 days…';
        const fc = this._forecastNext30Days(viSeries, wxByDate, model);

        // 6) 绘图
        this._plot(viSeries, fc, target);
        stats.textContent = `Done. Samples: ${ds.x.length}, RMSE (train): ${model.rmse?.toFixed?.(4) ?? '—'}`;
      } catch (e) {
        console.error(e);
        stats.textContent = `Failed: ${e.message}`;
      }
    },

    clear() {
      const stats = document.getElementById('fc-stats');
      const el = document.getElementById('fc-chart');
      if (stats) stats.textContent = '—';
      if (el && global.Plotly) Plotly.purge(el);
      if (!global.Plotly && el) el.innerHTML = '';
    },

    // ---------- data fetching ----------

    async _fetchVISeries(product, viType, lat, lng, years) {
      // 获取日期列表（按产品/点位）
      const datesJson = await VegetationManager.fetchDates(product, lat, lng);
      const entries = (datesJson?.dates || []).slice(-Math.ceil((365/16)*years)); // 估算 N 年
      const series = [];

      for (const d of entries) {
        const md = d?.modis_date || d; // 'YYYY-DOY' 或 'YYYY-MM-DD'
        try {
          const subset = await VegetationManager.fetchSubset(product, lat, lng, md, md);
          const bands = subset?.subset || [];
          const match = bands.find(b => (b.band || '').toLowerCase().includes(viType));
          const raw = Array.isArray(match?.data) ? match.data[0] : match?.data;
          const val = raw == null || raw <= -9000 ? null : Number(raw) * 0.0001;
          const iso = this._toISO(md);
          if (val != null && iso) series.push({ date: iso, value: val });
        } catch (_) { /* skip */ }
      }
      series.sort((a,b)=> (a.date < b.date ? -1 : 1));
      return series;
    },

    async _fetchWeatherByDate(viSeries, lat, lng) {
      if (!viSeries.length) return {};
      const start = viSeries[0].date.replace(/-/g,'');
      const end   = viSeries[viSeries.length-1].date.replace(/-/g,'');

      const url = new URL('https://power.larc.nasa.gov/api/temporal/daily/point');
      url.search = new URLSearchParams({
        parameters: 'T2M,PRECTOTCORR',
        community: 'AG',
        longitude: String(lng),
        latitude: String(lat),
        start: start,
        end: end,
        format: 'JSON'
      }).toString();

      const r = await fetch(url);
      if (!r.ok) throw new Error(`POWER error ${r.status}`);
      const data = await r.json();
      const T = data?.properties?.parameter?.T2M || {};
      const P = data?.properties?.parameter?.PRECTOTCORR || {};

      const get = (obj, ymd) => {
        const v = obj?.[ymd];
        const n = Number(v);
        return Number.isFinite(n) && n > -900 ? n : null;
      };

      const wx = {};
      for (const { date } of viSeries) {
        const d0 = new Date(`${date}T00:00:00Z`);
        let tList = [], pList = [];
        for (let k=-8; k<=8; k++) {
          const d = new Date(d0);
          d.setUTCDate(d0.getUTCDate()+k);
          const ymd = this._ymd(d);
          const tv = get(T, ymd);
          const pv = get(P, ymd);
          if (tv != null) tList.push(tv);
          if (pv != null) pList.push(pv);
        }
        const tMean = tList.length ? (tList.reduce((a,b)=>a+b,0)/tList.length) : null;
        const pSum  = pList.length ? (pList.reduce((a,b)=>a+b,0)) : null;
        wx[date] = { tMean, pSum };
      }
      return wx;
    },

    // ---------- dataset & features ----------

    _buildDataset(viSeries, wxByDate) {
      const x = [], y = [];
      const byDate = new Map(viSeries.map(v => [v.date, v.value]));
      const dates  = viSeries.map(v => v.date);

      const roll = (idx, win=3) => {
        const s = Math.max(0, idx-win+1);
        const arr = viSeries.slice(s, idx+1).map(v=>v.value).filter(v=>v!=null);
        return arr.length ? (arr.reduce((a,b)=>a+b,0)/arr.length) : null;
      };

      for (let i=2; i<viSeries.length; i++) {
        const d = dates[i];
        const v = byDate.get(d);
        const lag1 = byDate.get(dates[i-1]);
        const lag2 = byDate.get(dates[i-2]);
        const r7   = roll(i, 3);
        const wx   = wxByDate[d] || {};
        if (v==null || lag1==null || lag2==null || r7==null || wx.tMean==null || wx.pSum==null) continue;

        const doy  = this._doy(d);
        const f = [
          lag1, lag2, r7,
          Math.sin(2*Math.PI*doy/365), Math.cos(2*Math.PI*doy/365),
          wx.tMean, wx.pSum
        ];
        x.push(f);
        y.push(v);
      }
      return { x, y };
    },

    // ---------- model ----------

    async _trainModel(ds, { epochs, lr }) {
      const X = ds.x, Y = ds.y;

      // 标准化
      const mu = []; const sig = [];
      const cols = X[0].length;
      for (let j=0; j<cols; j++) {
        const col = X.map(r=>r[j]);
        const m = col.reduce((a,b)=>a+b,0)/col.length;
        const s = Math.sqrt(col.reduce((a,b)=>a+(b-m)*(b-m),0)/Math.max(1,(col.length-1))) || 1;
        mu[j]=m; sig[j]=s;
      }
      const xN = X.map(r => r.map((v,j)=>(v-mu[j])/sig[j]));

      const yMu = Y.reduce((a,b)=>a+b,0)/Y.length;
      const ySig = Math.sqrt(Y.reduce((a,b)=>a+(b-yMu)*(b-yMu),0)/Math.max(1,(Y.length-1))) || 1;
      const yN = Y.map(v => (v - yMu)/ySig);

      if (global.tf) {
        // tf.js 小型 MLP
        const model = tf.sequential();
        model.add(tf.layers.dense({ units: 32, activation: 'relu', inputShape: [cols] }));
        model.add(tf.layers.dense({ units: 16, activation: 'relu' }));
        model.add(tf.layers.dense({ units: 1 }));
        model.compile({ optimizer: tf.train.adam(lr), loss: 'meanSquaredError' });

        const tx = tf.tensor2d(xN);
        const ty = tf.tensor2d(yN, [yN.length, 1]);
        await model.fit(tx, ty, { epochs, verbose: 0, shuffle: true });
        const pred = model.predict(tx);
        const rmse = Math.sqrt((await pred.sub(ty).square().mean().data())[0]) * ySig;
        tx.dispose(); ty.dispose(); pred.dispose();

        const infer = (row) => {
          const r = row.map((v,j)=>(v-mu[j])/sig[j]);
          const t = tf.tensor2d([r]);
          const p = model.predict(t);
          const vhat = p.dataSync()[0]*ySig + yMu;
          t.dispose(); p.dispose();
          return vhat;
        };
        return { type:'tf', infer, rmse };
      } else {
        // 线性回归（最小二乘）
        const XT = this._transpose(xN);
        const XTX = this._matMul(XT, xN);
        const XTy = this._matVec(XT, yN);
        const XTXinv = this._invSym(XTX);
        const w = this._matVec(XTXinv, XTy);
        const rmse = Math.sqrt(this._mse(this._matVec(xN, w), yN)) * ySig;

        const infer = (row) => {
          const r = row.map((v,j)=>(v-mu[j])/sig[j]);
          const yn = r.reduce((a,b,idx)=>a + b*w[idx], 0);
          return yn*ySig + yMu;
        };
        return { type:'lin', infer, rmse };
      }
    },

    _forecastNext30Days(viSeries, wxByDate, model) {
      const out = [];
      const keys = Object.keys(wxByDate);
      const take = keys.slice(-Math.min(30, keys.length));
      const tArr = take.map(d=>wxByDate[d]?.tMean).filter(v=>v!=null);
      const pArr = take.map(d=>wxByDate[d]?.pSum).filter(v=>v!=null);
      const tConst = tArr.length ? (tArr.reduce((a,b)=>a+b,0)/tArr.length) : 10;
      const pConst = pArr.length ? (pArr.reduce((a,b)=>a+b,0)/pArr.length) : 10;

      const hist = viSeries.slice();
      let d = new Date(hist[hist.length-1].date+'T00:00:00Z');

      for (let i=1; i<=30; i++) {
        d.setUTCDate(d.getUTCDate()+1);
        const iso = d.toISOString().slice(0,10);

        const len = hist.length;
        const lag1 = hist[len-1]?.value ?? null;
        const lag2 = hist[len-2]?.value ?? null;
        const r3 = (()=>{
          const arr = hist.slice(-3).map(v=>v.value).filter(v=>v!=null);
          return arr.length? (arr.reduce((a,b)=>a+b,0)/arr.length): null;
        })();
        if (lag1==null || lag2==null || r3==null) { out.push({ date: iso, value: null }); continue; }

        const f = [
          lag1, lag2, r3,
          Math.sin(2*Math.PI*this._doy(iso)/365), Math.cos(2*Math.PI*this._doy(iso)/365),
          tConst, pConst
        ];
        const vhat = model.infer(f);
        const clipped = Math.max(-0.1, Math.min(1.0, vhat));
        out.push({ date: iso, value: clipped });
        hist.push({ date: iso, value: clipped });
      }
      return out;
    },

    // ---------- plotting ----------

    _plot(hist, fc, label) {
      const el = document.getElementById('fc-chart');
      if (!el) return;

      if (!global.Plotly) {
        // 简易兜底：无 Plotly 时用原生生成列表
        el.innerHTML = '<pre>'+[
          'HISTORY (date,value):',
          ...hist.map(d=>`${d.date}\t${d.value!=null?d.value.toFixed(4):'null'}`),
          '',
          'FORECAST (date,value):',
          ...fc.map(d=>`${d.date}\t${d.value!=null?d.value.toFixed(4):'null'}`)
        ].join('\n')+'</pre>';
        return;
      }

      const trHist = {
        x: hist.map(d=>d.date),
        y: hist.map(d=>d.value),
        mode: 'lines+markers',
        name: `${label.toUpperCase()} (history)`
      };
      const trFc = {
        x: fc.map(d=>d.date),
        y: fc.map(d=>d.value),
        mode: 'lines+markers',
        name: `${label.toUpperCase()} (forecast)`,
        line: { dash: 'dash' }
      };

      Plotly.newPlot(el, [trHist, trFc], {
        margin: { l: 40, r: 10, t: 10, b: 40 },
        yaxis: { title: label.toUpperCase(), range: [-0.1, 1.0] },
        xaxis: { title: 'Date' }
      }, { displayModeBar: false, responsive: true });
    },

    // ---------- helpers ----------

    _toISO(modisDate) {
      if (/^\d{4}-\d{3}$/.test(modisDate)) {
        const [y, doy] = modisDate.split('-').map(Number);
        return (global.Utils && Utils.doyToDate) ? Utils.doyToDate(y, doy) : this._doyToDate(y, doy);
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(modisDate)) return modisDate;
      return null;
    },

    _ymd(d) {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth()+1).padStart(2,'0');
      const dd = String(d.getUTCDate()).padStart(2,'0');
      return `${y}${m}${dd}`;
    },

    _doy(iso) {
      const d = new Date(iso+'T00:00:00Z');
      const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 0));
      const diff = d - start;
      return Math.floor(diff / (1000*60*60*24));
    },

    _doyToDate(year, doy) {
      const d = new Date(Date.UTC(year, 0, 1));
      d.setUTCDate(d.getUTCDate() + (doy - 1));
      return d.toISOString().slice(0,10);
    },

    _transpose(A){ return A[0].map((_,i)=>A.map(r=>r[i])); },
    _matMul(A,B){ return A.map((r,ri)=>B[0].map((_,j)=>r.reduce((s,_,k)=>s + A[ri][k]*B[k][j],0))); },
    _matVec(A,v){ return A.map(r=>r.reduce((s,_,j)=>s + r[j]*v[j],0)); },
    _mse(yhat, y){ const n=y.length; let s=0; for(let i=0;i<n;i++) s+=(yhat[i]-y[i])**2; return s/Math.max(1,n); },
    _invSym(M){
      const n = M.length;
      const A = M.map(r=>r.slice());
      const I = Array.from({length:n}, (_,i)=> Array.from({length:n}, (_,j)=> i===j?1:0));
      for (let i=0;i<n;i++){
        let p=i; for(let r=i+1;r<n;r++) if (Math.abs(A[r][i])>Math.abs(A[p][i])) p=r;
        if (Math.abs(A[p][i])<1e-8) throw new Error('Singular matrix');
        [A[i],A[p]]=[A[p],A[i]]; [I[i],I[p]]=[I[p],I[i]];
        const invPivot = 1/A[i][i];
        for (let j=0;j<n;j++){ A[i][j]*=invPivot; I[i][j]*=invPivot; }
        for (let r=0;r<n;r++){
          if (r===i) continue;
          const f=A[r][i];
          for (let j=0;j<n;j++){ A[r][j]-=f*A[i][j]; I[r][j]-=f*I[i][j]; }
        }
      }
      return I;
    }
  };

  // 导出到全局
  global.ForecastManager = ForecastManager;

})(window);
