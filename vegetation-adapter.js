<script>
/* vegetation-adapter.js */
(function (w) {
  if (w.VegetationManager) return;

  function modisToISO(md) {
    if (/^\d{4}-\d{3}$/.test(md)) {
      const [y, doy] = md.split('-').map(Number);
      const d = new Date(Date.UTC(y, 0, 1));
      d.setUTCDate(d.getUTCDate() + (doy - 1));
      return d.toISOString().slice(0, 10);
    }
    return md;
  }

  w.VegetationManager = {
    async fetchDates(product, lat, lng) {
      const url = `https://modis.ornl.gov/rst/api/v1/${product}/dates?latitude=${lat}&longitude=${lng}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`RST dates ${r.status}`);
      return r.json(); // { dates: [...] }
    },
    async fetchSubset(product, lat, lng, start, end) {
      // start/end 支持 YYYY-DOY 或 YYYY-MM-DD
      const sd = modisToISO(start);
      const ed = modisToISO(end);
      // 取 NDVI/EVI 波段
      const bands = 'NDVI,EVI';
      const url = `https://modis.ornl.gov/rst/api/v1/${product}/subset?latitude=${lat}&longitude=${lng}&startDate=${sd}&endDate=${ed}&bands=${bands}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`RST subset ${r.status}`);
      return r.json(); // { subset: [{ band:'NDVI', data:[...], ...}, ...] }
    }
  };
})(window);
</script>
