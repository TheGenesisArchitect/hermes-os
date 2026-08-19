// Read the dashboard's own /api/health and print a readable breakdown.
(async () => {
    const r = await fetch("http://127.0.0.1:3777/api/health");
    const h = await r.json();
    const fmt = (o) => JSON.stringify(o);
    console.log("OVERALL:  ", fmt(h.overall));
    console.log("SERVICES: ", fmt(h.services));
    console.log("PIPELINE: ", fmt(h.pipeline));
    console.log("SELLROUTE:", fmt(h.sellRoute));
    console.log("PUMPPORTAL:", fmt(h.pumpportal));
    console.log("FEEDS:    ", fmt(h.feeds));
})();
