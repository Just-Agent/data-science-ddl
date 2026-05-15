import fs from 'node:fs';

async function kaggleAdapter() {
  return {
    source: "Kaggle Competitions",
    url: "https://www.kaggle.com/competitions",
    items: [],
    note: 'TODO: implement parser for Kaggle Competitions; keep data/items.json as curated fallback until parser is verified.'
  };
}

async function tianchiAdapter() {
  return {
    source: "Alibaba Tianchi",
    url: "https://tianchi.aliyun.com/competition/gameList/activeList",
    items: [],
    note: 'TODO: implement parser for Alibaba Tianchi; keep data/items.json as curated fallback until parser is verified.'
  };
}

async function drivenDataAdapter() {
  return {
    source: "DrivenData Competitions",
    url: "https://www.drivendata.org/competitions/",
    items: [],
    note: 'TODO: implement parser for DrivenData Competitions; keep data/items.json as curated fallback until parser is verified.'
  };
}

async function codalabAdapter() {
  return {
    source: "Codalab Competitions",
    url: "https://codalab.lisn.upsaclay.fr/competitions/",
    items: [],
    note: 'TODO: implement parser for Codalab Competitions; keep data/items.json as curated fallback until parser is verified.'
  };
}

const adapters = [kaggleAdapter, tianchiAdapter, drivenDataAdapter, codalabAdapter];
const existingItemsUrl = new URL('../data/items.json', import.meta.url);
const existingItems = JSON.parse(fs.readFileSync(existingItemsUrl, 'utf8'));
const reports = [];

for (const adapter of adapters) {
  reports.push(await adapter());
}

const harvestedItems = reports.flatMap(report => report.items);
if (harvestedItems.length > 0) {
  fs.writeFileSync(existingItemsUrl, JSON.stringify(harvestedItems, null, 2) + '\n', 'utf8');
  console.log(`crawler wrote ${harvestedItems.length} fetched items`);
} else {
  console.log(`crawler adapters ran; no verified fetched items yet, preserving ${existingItems.length} curated items`);
}

fs.writeFileSync(new URL('../data/crawl-report.json', import.meta.url), JSON.stringify({
  generatedAt: new Date().toISOString(),
  topicId: "data-science-ddl",
  adapters: reports
}, null, 2) + '\n', 'utf8');
