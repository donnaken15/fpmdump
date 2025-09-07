
import {sleep, sleepSync, 'spawnSync' as cmd, $} from 'bun';
import {'escape' as esc, 'unescape' as unesc} from 'he';
import {'stringify' as q, 'parse' as parse_q} from 'qs';
import {inspect} from 'util';
import {JSDOM} from 'jsdom';
import {
	'writeFileSync' as write,
	'copyFileSync' as copy,
	'linkSync' as link,
	'unlinkSync' as remove,
	'existsSync' as exists
} from 'fs';
var [log, error] = [console.log, console.error];
// why does it still need to be like this years after, literally fly above chair
// https://stackoverflow.com/a/75757070 also LOL number pattern
// https://github.com/jsdom/jsdom/issues/3236
// useless when im already using an (basically) alias
console.error = (m, ...args) => {
	if (m.indexOf('Could not parse CSS stylesheet') >= 0) {
		return;
	}
	error(m, ...args);
};
const [channel, input, quit] = [process.stdout, process.stdin, process.exit];
const w = (...a) => channel.write(...a);
const LOG_SCANNERS = false;
const node_props = [
	"textContent",
	"innerHTML",
	"innerText",
];
// just ripping my own code out of xrpt, yolo
function scrape(doc, scanner, bail_if_missing=[]) {
	var builder = {};
	var scanners = {};
	var no_hope = false;
	// TODO?: special reserved character for identifying root selector thats being scraped
	// so: scrape(testitem, scanner) with scanner={thing:{select:["@ > span"],value:...}}
	// where @ = testitem
	for (var key in scanner)
	{
		var q = scanner[key], sel = null, acc = null, found = false, worked = null;
		if (q.hasOwnProperty('select') && q.hasOwnProperty('value'))
			q = [ q ];
		if (Array.isArray(q))
			q = { tree: q };
		for (var i = 0; i < q.tree.length; i++)
		{
			var qs = q.tree[i].select;
			if (Array.isArray(qs))
				qs = qs.join(' ');
			sel = doc.querySelector(qs);
			if (!sel)
				continue;
			if (q.tree[i].hasOwnProperty('has'))
			{
				qs = q.tree[i].select;
				var top = doc.querySelectorAll(Array.isArray(qs)?qs[0]:qs);
				var hasnt = true;
				for (var j = 0; j < top.length; j++)
					if (top[j].querySelector(q.tree[i].has) !== null)
					{
						hasnt = false;
						sel = top[j];
						if (Array.isArray(qs))
							sel = sel.querySelector((q.tree[i].direct?':scope>':'')+qs.slice(1).join(' '));
						break;
					}
				if (hasnt || sel === null)
					continue;
			}
			found = true;
			acc = q.tree[i].value;
			if (typeof acc === 'string')
			{
				if (!node_props.includes(acc))
				{
					var attr = acc; // ugh
					acc = o=>o.getAttribute(attr);
				}
			}
			worked = i;
			break;
		}
		var desc = builder;
		if (!found && bail_if_missing.includes(key)) {
			no_hope = true;
			error('missing important key: '+key+', exiting');
			break;
		}
		if (!q.important && !found)
			continue;
		var c = key.split('.');
		for (var x = 0; x < c.length; x++)
		{
			var k = c[x];
			if (x<c.length-1)
			{
				if (!desc.hasOwnProperty(k))
					desc[k] = {};
				desc = desc[k];
			}
			else
			{
				try {
					var content = (!found ? ("MISSING") : (typeof acc === 'function' ? acc(sel) : sel[acc]));
					if (found && LOG_SCANNERS)
						scanners[key] = {
							worked,
							content
						}; // log which selector worked first
					if (typeof content === 'string')
						content = content.trim();
					desc[k] = content;
				} catch(e) {
					error(e.message);
					error(key);
					error(q.tree[worked]);
					if (bail_if_missing.includes(key)) {
						no_hope = true;
						error('missing important key: '+key+', exiting');
						break;
					}
				}
			}
		}
		if (no_hope) // why
			break;
	}
	if (LOG_SCANNERS)
	{
		if (true)
		for (var i in scanners) // die a-gnostics
		{
			var test = scanner[i];
			if (test.hasOwnProperty('select') && test.hasOwnProperty('value'))
				test = [ test ];
			if (Array.isArray(test))
				test = { tree: test };
			test = test.tree;
			scanners[i] = {
				content: scanners[i].content,
				worked_index: scanners[i].worked,
				worked: test[scanners[i].worked].select,
				last: test.length-1
			};
		}
		builder._scanners = scanners;
	}
	if (no_hope)
	{
	//	log(doc.innerHTML);
		return null;
	}
	return builder;
}
function map(c=(v,k,o)=>v,_this) {
	if (typeof _this === 'undefined')
		_this = this;
	var _new = {..._this};
	Object.keys(_new).forEach(k=>_new[k]=c(_new[k],k,_new));
	return _new;
}
function concat_regex(...rs) {
	var flags = '';
	var src = '';
	rs.forEach((r,i)=>{
		if (!(r instanceof RegExp))
			throw new Error("Parameter "+i+" "+String(r)+" is not regex");
		flags += r.flags;
		var s = r.source;
		if (s.startsWith('^') && i > 0) // ONE THING, I
			s = s.slice(1);
		if (s.endsWith('$') && i < rs.length-1)
			s = s.slice(0,-1);
		src += s;
	});
	return new RegExp(src, flags.split("").sort().join("").replace(/(.)(?=.*\1)/g, ""));
}
function make_group(regex, name='', opt=false) {
	return new RegExp("("+(name!==''?('?<'+name.replace(/[<>]/g,'\\$&')+'>'):'')+regex.source+")"+(opt?'?':''), regex.flags);
}
const esc4rgx = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // why does everyone lie to me
const common_regex = map((r,_,t)=>concat_regex(...(Array.isArray(r) ? r.map(s=>typeof s==='string'?t[s]:s) : [r])), {
	datefmt:		[/^(\d{4})/,...(new Array(5).fill(/(\d{2})/)),/$/],
});
const field_types = {
	"timestamp": "date",
	"statuscode": "int",
}
function csvf2json(_) {
	var list = Array.from(_);
	var fields = list.shift();
	return list.map(e=>{
		var o = {};
		e.forEach((val,i)=>{
			var col = fields[i];
			switch (field_types[col])
			{
				case 'int':
					val = (val === '-') ? null : parseInt(val);
					break;
				case 'date':
					val = new Date(...common_regex.datefmt.exec(val).slice(1).map((x,i)=>{
						if (i===1) x--; // STUPID!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
						return x;
					}));
					break;
			}
			o[col] = val;
		});
		return o;
	});
}
const wbts = (d8) => [ 1900+d8.getYear(), d8.getMonth()+1, ...(['Date','Hours','Minutes','Seconds'].map(s=>d8['get'+s]())) ].map(s=>s.toString().padStart(2,'0')).join('');

const best_fields = ["original",/*"mimetype","statuscode",*/"timestamp"], no_errors = /[45]..|30[12]/;
const _2XX_only = "!statuscode:"+(no_errors.source);
const host = "https://web.archive.org/", ns = host+"web/";
const api_url = (endp,params,filter=[],h=host) => (h+escape(endp)+'?'+q(params)+(filter.map(s=>'&filter='+s.replaceAll('&','%26')).join('')));
var mb_ns = "https://musicbrainz.org/ws/2/";
const nuke = (obj,keys=[]) => keys.forEach(k=>{
	var r = obj;
	var keys = !Array.isArray(k) ? k.split('.') : k;
	var lp = keys.pop();
	for (var x = 0; x < keys.length; x++) {
		r = r[keys[x]];
	}
	delete r[lp];
});
const uuid2buf = uuid => Buffer.from(uuid.replaceAll('-',''),'hex').toString('base64url').replace(/=+$/,'');

log("scraping homepage captures");
var trax = [], vols = [], moods = [], tempos = [], styles = [], parts = [], data = {
	parts, styles, moods, tempos, volumes: vols, tracks: trax
};
var era = [/^20(1[4-9]|2[0-9])/,/^200[0-4]/,/^20[2-9][0-9]/,/^20(1307(2[4-9]|3)|130[8-9]|131)/].map(r=>("!timestamp:"+r.source));
var index_pages = (await (Promise.all((
	await Promise.all(['freeplaymusic.com/index.php','freeplaymusic.com']. // MOST AUTISTIC LINE EVER
		map(f=>fetch(api_url("cdx/search/xd", { output: "json", url: f, fl: String(best_fields), }, [
			_2XX_only, '!mimetype:warc/revisit', 'mimetype:text/html?',...era
		])))
	)
).map(async f=>await f.json())))).map(csvf2json).reduce((a,b)=>a.concat(b),[]).sort((a,b)=>a.timestamp.getTime()-b.timestamp.getTime()).map(e=>ns+wbts(e.timestamp)+"/"+e.original);
log(index_pages.length);
for (var i = 0; i < Math.min(Infinity,index_pages.length); i++) {
	var req = await fetch(index_pages[i]);
	if (!req.ok) {
		error('why',req);
		continue;
	}
	try {
		w(String(i)+"/"+String(index_pages.length).padEnd(5)+"\r");
		var pagetext = await req.text();
		var page = new JSDOM(pagetext).window.document;
		var snoo = page.querySelector([
			'div[style="height: 465; width=100%; overflow: auto;"]',
			'div[style="height: 425; width=100%; overflow: auto;"]',
			'font[face="Century Gothic, Verdana, Arial, Helvetica"]'
		].toString());
		// get volume ids
		var lynx = Array.from(snoo.querySelectorAll('a[href*="category_search.php"]')).
			map(e=>[e.textContent,parse_q(new URL(host+e.href).search, {ignoreQueryPrefix:true})]).
			filter(e=>(!isNaN(e[1].i??"?"))&&e[1].t==='v');
		lynx.forEach(e=>e[1]=Number(e[1].i));
		if (lynx.length < 1) {
			for (var x = 0; x < 5; x++)
				error(index_pages[i]);
			continue; // wtf
		}
		for (var v = 0; v < lynx.length; v++) {
			var vol = lynx[v];
			vols[vol[1]-1] = {title:vol[0]};
		}
		// 2013 captures have CORRUPTED TEXT https://web.archive.org/web/20130620090901/http://freeplaymusic.com/
		// stupidly formatted tagline on June, 18, 2008
		var relnotergx = /^ *(?<date>[A-Z]+[.,]{0,3} *\d+((st|[nr]d|th))?,? *\d+) \- +(ELECTION DAY SPECIAL!! )?["“]?(?!INDIE ARTIST)(?<vol>((?!Vol)[\w&+\.\-]+\s+)+Vol(\.|ume)? \d+|(Frequency|The Master Classics: ).+|.+(Selections|Movements))( *- *|["”]|\n|,? *)(?<blurb>.+\n((?!Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec| )(.+\n)+\n)?)/gmi, test = null;
		snoo.textContent.matchAll(relnotergx).toArray().forEach(m=>{ // had memory overflow using exec
			var title = m.groups.vol.trim().replace(/^ - /,'');
			var date = new Date(m.groups.date.replace(/(\d+)(st|[nr]d|th)/g,'$1'));
			//log(title,m.groups.date,date);
			var vol = vols.find(e=>(e??{title:null}).title===title) ?? null;
			if (vol !== null && !isNaN(date)) {
				vol.date = date;
				vol.desc = m.groups.blurb.trim();
			}
			//if (vol === null)
			//	error(m.groups);
			//log(vol);
		});
		// FPM literally making DRM webpages in PHP and MySQL by not naming elements and using thousands of tables and <font>s
	} catch (e) {
		error(i,index_pages[i]);
		error(e);
		error(pagetext);
	}
}

log("loading musicbrainz meta");
var mb_short = / \((\d+) second version\)$/;
var mb_db = [];
var mb_songs = [];
{
	var i = 0, end = null;
	do {
		var call = api_url("release", {
			label: "363f4fce-b4b2-412b-bf7d-a03557996e80",
			fmt: "json", limit: 20, offset: i, inc: String(["recordings"])
		}, [], mb_ns);
		log(call);
		// gets about 17 releases including track info, 100 if not included
		var quarry = await (await fetch(call)).json();
		if (quarry.hasOwnProperty('error')) {
			error(new Error(quarry.error));
			await sleep(3000);
			continue;
		}
		mb_db = mb_db.concat(quarry.releases);
		w(String(i)+" | "+String(quarry['release-offset'])+", "+String(mb_db.length)+" += "+String(quarry.releases.length)+", "+String(end).padEnd(6)+"\r");
		i += quarry.releases.length;
		end = quarry['release-count'];
		await sleep(800); // rate limited
	} while (i < end);
	mb_db.forEach(r=>{
		nuke(r,['asin','packaging-id','status-id','barcode','quality','disambiguation',
				'cover-art-archive','status','packaging','text-representation']);
		r.id = uuid2buf(r.id);
		r.tracks = r.media[0].tracks; // no CDs here (despite them existing (debatebro face))
		delete r.media;
		r.tracks.forEach(t=>{
			nuke(t,['number','position','recording']);
			t.var = Number((mb_short.exec(t.title) ?? [null,0])[1]);
			t.title = t.title.replace(mb_short,'');
			t.id = uuid2buf(t.id);
			t.length /= 1000;
		});
		{
			var find_rel = r.title.replace(/,|(Vol)ume/g,'$1').toLowerCase();
			var test = vols.find(v=>{
				if ((v ?? null) === null)
					return false;
				var a = (v??{title:"\uffff"}).title.toLowerCase();
				var b = find_rel;
				log(b,'===',a);
				return a===b;
			});
			if ((test ?? null) !== null) {
				var ind = vols.indexOf(test);
				test.mbid = r.id;
				log(test);
			} else error('missed',find_rel);
			mb_songs.concat(r.tracks);
		}
		// find data.tracks[*] with matching title and length
	});
}
log(mb_db);

log("loading capture list (category_search)");
var search = await fetch(api_url("cdx/search/xd", {
	output: "json", url: "freeplaymusic.com/search/category_search.php",// collapse: "urlkey", // literally exhaustive search scraping the same query over years...
	matchType: "prefix", fl: String(best_fields),// limit: 100
}, [ _2XX_only, '!mimetype:warc/revisit', 'mimetype:text/html?', ...era ]));
if (!search.ok)
{
	error('failed request (category_search): '+search.status+' '+search.statusText+'');
	quit(1);
}
var caps = csvf2json(await search.json()).map(e=>{
	var url = new URL(e.original);
	return {
		date: e.timestamp,
		url: url.href,
		origin: url.origin,
		proto: url.protocol,
		host: url.host,
		// hoping port autoresolves to 80 or 443 because some capture urls explicitly have it
		path: url.pathname,
		search: url.search,
		params: parse_q(url.search.replace(/&(amp)?;?/g,'&'), {ignoreQueryPrefix:true})
	};
}).sort((a,b)=>a.date.getTime()-b.date.getTime());
var restable = [
	'html table','tr>td>table',
	'tr:last-child>td>table',
	//'tr:nth-child(2)>td>table'
];
var listscanners = {
	count: {
		select: [
			...restable,
			'tr>td>table:nth-child(1)',
			'tr>td:nth-child(1)>font:nth-child(2)>font',
		], value: e=>Array.from(/(\d+) tracks found \(displaying (\d+) through (\d+)\)/.exec(e.textContent)).slice(1).map(i=>Number(i))
	},
	entries: { // REPLACE WITH JUST TWO SELECTIONS??
		select: [
			...restable,
			'tr>td>table:nth-child(2)',
		], value: (e)=>{
			return Array.from(
				e.querySelectorAll('tr>td[width="33%"],tr>td[width="50%"]') // WHY IS THE FIRST CELL ALWAYS 33%
			).filter(e=>e.hasChildNodes());
		}
	}
};
function parseTime(str) {
	str = str.trim();
	if (/full|under/i.test(str)) // WTF?!?!?!?!?! https://web.archive.org/web/20061017072540/http://www.freeplaymusic.com/search/category_search.php?t=v&i=50
		return "N/A";
	var caps = /^((\d+):)?(\d+)?:(\d+)$/.exec(str);
	if (caps === null) {
		error(str);
		return NaN;
	}
	var digits = Array.from(caps).slice(2).map(n=>Number(n??0));
	return (digits[0]*3600)+(digits[1]*60)+(digits[2]);
}
function dequote(text) {
	if (/^["].+["]$/.test(text))
		text = text.slice(1,-1);
	return text;
}
function subst(argv) {
	var test = cmd(argv);
	var err = test.stderr.toString('utf8').trim();
	if (err.length > 0)
		error(err);
	return test.success ? test.stdout.toString('utf8').replace(/[\r\n]/g,'') : null;
}
const optnum = n => isNaN(n) ? n : Number(n);
// link inserted in publish text: https://web.archive.org/web/20040626150039/http://www.freeplaymusic.com/search/category_search.php?sindex=11&i=10&t=s
// 46s song: https://web.archive.org/web/20060819150304/http://www.freeplaymusic.com/search/category_search.php?t=v&i=1017
// (ZERO) HOUR DIGIT!!!!!! https://web.archive.org/web/20080611013016/http://www.freeplaymusic.com/search/category_search.php?t=v&i=1155
// WTFFFFFFFFFFFFFF https://web.archive.org/web/20060315063700/http://www.freeplaymusic.com/search/category_search.php?t=v&i=14
// songs from this volume had its IDs changing over time, WHY (check captures from 2004 and 2009):
// https://web.archive.org/web/20040502160402/http://www.freeplaymusic.com/search/category_search.php?t=v&i=1
var song_head = /^(\d+)\. (.+) \( *((\d+:\d+|\d*):\d+|[Ff]ull)\) - Found on$/, qtagline = /^"(.+)"$/, song_prop = {
	title: { // why does tbody exist
		select: "table>tbody>tr:nth-child(1)>td>font",
		value: e=>Array.from(song_head.exec(e.childNodes[0].wholeText.trim())).slice(1)
	}, vol: {
		select: "table>tbody>tr:nth-child(1)>td>font>a",
		value: e=>({
			title: e.textContent,
			id: Number(new URL(ns+e.href).searchParams.get("i"))
		})
	}, desc: {
		select: "table>tbody>tr:nth-child(2)>td>font>i",
		value: e=>dequote(e.childNodes[0].wholeText.trim())
	}, tags: {
		select: "table>tbody>tr:nth-child(2)>td>font>font",
		value: e=>{
			var test = e.querySelectorAll("a:link:not([href*=\"_file.php\"]):not(.lnko)");
			return Array.from(test).map(e=>({
				// no regard for NaN, because i===number is mandatory
				qs: map((v,k)=>((['i','tempo'].includes(k))?Number(v):v),parse_q(new URL(ns+e.href).search,{ignoreQueryPrefix:true})),
				text: e.textContent
			}));
		}
	}, files: {
		select: "table>tbody>tr:nth-child(2)>td>font>font",
		value: e=>Array.from(e.querySelectorAll("a:link[href*=\"download_file.php\"]")).
			map(e=>parse_q(new URL(ns+e.href).search,{ignoreQueryPrefix:true})).
			map(e=>({id:Number(e.id),dur:optnum(e.dur),type:e.type}))
	}, byline: {
		select: "table>tbody>tr:nth-child(2)>td>font>font>font>font>font",
		value: n=>Array.from(n.childNodes).filter(e=>e.nodeType===e.TEXT_NODE).
				map(t=>t.wholeText.trim()).filter(t=>t!=='')
	}
};
var gcint = 100, gci = 0;
var enums = { v: 'volumes', f: 'moods', s: 'styles' }; // t param
// i = volume number/mood enum/style enum, sindex = results offset
var bylines = ["Composed","Published"].map(s=>concat_regex(/^/,new RegExp(esc4rgx(s)),/ by: ?(.*)$/));
var page, doc, list, songs, url, pain = null;
for (var i = 263; i < caps.length; i++) {
	url = caps[i];
	if (Object.keys(url.params) < 1)
		continue;
	if (url.params.sindex < 1) {
		error('non-positive search offset',url.params.sindex);
		continue;
	}
	log(i,caps.length,url.date,"current URL: "+(enums[url.params.t] ?? "???")+" #"+url.params.i,url.url);
	do {
		page = await fetch(ns+wbts(url.date)+"if_/"+url.url);
		if (!page.ok) {
			error(url, page.statusText);
			await sleep(1000);
			continue;
		}
		doc = new JSDOM(await page.text()).window.document; // terminal illness
		list = scrape(doc, listscanners, ['entries','count']);
		if (list === null) {
			error('null');
			continue;
		}
		songs = list.entries.map(s=>scrape(s, song_prop, Object.keys(song_prop)));
		//log(inspect(songs.map(s=>s.tags),null,100,true));
		for (var z = 0; z < songs.length; z++) {
			var s = songs[z];
			if (s === null) {
				error("why",s);
				continue;
			}
			if (s.files.length === 0) { // AYFKM?!?! (3rd song) https://web.archive.org/web/20090216144055/http://freeplaymusic.com/search/category_search.php?t=v&i=1474
				error("HOW");
				continue;
			}
			var id = s.files[0].id - 1;
			if (trax[id] !== undefined) {
				if (trax[id].title !== s.title[1])
					error('conflict',id,trax[id],s);
				else
					continue; // probably safe to skip duplicate entries for now...
			}
			var vol = s.vol.id-1;
			var vars = s.files.map(f=>f.dur);
			var item = (trax[id] = {
				title: s.title[1], time: parseTime(s.title[2]),
				desc: s.desc, volume: vol, //page: url, //id: id,
				formats: Array.from(new Set(s.files.map(f=>f.type))),
				vars: Array.from(new Set(vars.filter(d=>d>0))),
				found: url.date, search: url.search
			});
			['comp','pub'].forEach((e,ii)=>{
				try {
					item[e] = (bylines[ii].exec(s.byline[ii])[1]).replace(/[, ]+$|^[, ]+/gmi,'').trim();
					//.split(/((,+ ?)+)/g), // causing conflicts, like Artist, Publisher, Artist, Publisher
				} catch (ex) {
					error(s.byline);
					error(ex);
				}
			});
			item.pub.replace(/^Arranged By /i,()=>(item.orch=true,""));
			if (!vars.includes(0))
				item.short = true;
			if (vols[vol] === undefined) {
				vols[vol] = { title: s.vol.title };
			}
			s.tags.forEach(t=>{ // this is becoming a mess, don't care right now
				if (t.qs.t !== undefined) { // hate
					var index = t.qs.i-1;
					var name = enums[t.qs.t];
					var taglist = data[name];
					if (taglist[index] === undefined)
						taglist[index] = t.text;
					if (item[name] === undefined)
						item[name] = [];
					item[name].push(index);
					if (t.qs.t === 'v')
						item.trackno = Number(s.title[0]);
				} else if (t.qs.tempo !== undefined) {
					var index = t.qs.tempo-1;
					if (tempos[index] === undefined)
						tempos[index] = t.text;
					item.tempo = index;
				} else if (t.qs.instrument !== undefined) {
					var part_indexes = dequote(t.text.toLowerCase()).split(/, ?|,? and |\/|\.$/g).filter(s=>s!=="");
					item.parts = part_indexes.map(e=>{
						// STUPID WEBSITE has some instruments abbreviated (elec. gtr.) and plurals WTF
						e = e.trim();
						if (!parts.includes(e))
							parts.push(e);
						return parts.indexOf(e);
					});
				} else error("uncaught????",t);
			});
			if (item.styles !== undefined) { // hate me
				item.style = item.styles[0];
				delete item.styles;
			}
			// ADD: if a property in all songs in a volume match,
			// then insert details in volume object and delete from song objects;
			// obvious example having same credits, same trimmed down durations:
			// http://web.archive.org/web/20091206221732/http://freeplaymusic.com/search/category_search.php?t=v&i=1707
			if (true) { // run if whole library is downloaded locally
				// if i dont have it, then no one else must
				var base = "../fpmdump/download_file.php@id="+(s.files[0].id)+"&dur=0&type=";
				item.formats = item.formats.filter(f=>exists(base+f));
				if (item.formats.length < 1) // there'll always (most likely(???)) be an MP3 version
					item.unsaved = true;
				else {
					var stupid = item.formats[0].replace(/^aac$/,'m4a');
					var wtf = "DIE."+stupid, please = base+stupid;
					if (exists(please)) {
						await pain; // LOL
						pain = (async()=>{
							try {
								if (exists(wtf))
									remove(wtf);
								copy(please, wtf);
								// bpm-tools compiled on windows is shutting down pipe early WTF https://donnaken15.com/bpm.exe
								// downloaded straight from https://www.pogo.org.uk/~mark/bpm-tools/
								var est_bpm = null;
								est_bpm = subst(true ? ['c:/program files (x86)/bpm counter/consolebpm.exe',wtf] : ["wsl","ffmpeg","-v","error","-i",wtf,"-f","f32le","-","|","bpm"]);
								if (est_bpm !== null)
									item.ebpm = Number(est_bpm);
								// remind me to add bpm counter to the getmytool copy
								if ((item.date ?? null) === null)
									item.date = new Date(subst(["ffprobe","-v","error","-show_entries","format_tags=date","-of","default=noprint_wrappers=1:nokey=1",wtf]));
								if (item.date.getFullYear() < 2000)
									delete item.date;
								vars.forEach(v=>{
									if (exists(please.replace(/(&dur)=0(&type=)/,'$1='+v+'$2'))) {
										// i forgot what i wanted to do here
									} else {
										error(item.title,"has",v,"second track missing");
										item.vars = item.vars.filter(n=>n!==v);
										// item.vars.splice(ii,1); // dont trust this when later indexes will change
									}
								});
							} catch (e) {
								error(e);
							}
						})();
					} else {
						error('song',item.title,'is not archived');
						item.unsaved = true;
						// I ALWAYS FORGET TO SAAAAAAAAAAAAAAVE-AAAAAAAAAHHHHHHHHH
					}
				}
			}
		}
	} while (false);
	data.version = new Date();
	write("disco.json",JSON.stringify(data,null/**/,'\t'/**/));
	if (++gci >= gcint) {
		gci = 0;
		Bun.gc();
		log('gc');
	}
	await sleep(800);
}
log(inspect(data,null,100,true));
remove("DIE.MP3");

/*

download all captured audio, but saved into a messy folder (45GB TOTAL!!!!!):
curl "https://web.archive.org/web/timemap/csv?url=https://freeplaymusic.com/search/download_file&matchType=prefix&collapse=urlkey&fl=timestamp,original&filter=mimetype:a(pplication|udio)&limit=30000&___list.txt" | sed "s/^\([0-9]\+\) /https:\/\/web\.archive\.org\/web\/\1id_\//" -- - | wget -i - -nv --show-progress -Ew 3 --waitretry=6 -P fpmdump

*/

