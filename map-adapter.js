<script>
/* map-adapter.js */
(function (w) {
  if (w.MapManager && typeof w.MapManager.getCurrentLocation === 'function') return;

  w.MapManager = {
    getCurrentLocation() {
      try {
        if (w.Map && typeof w.Map.getCenter === 'function') {
          const c = w.Map.getCenter();
          return { lat: c.lat, lng: c.lng };
        }
      } catch (_) {}
      return { lat: 52.5200, lng: 13.4050 }; // Berlin fallback
    }
  };
})(window);
</script>
