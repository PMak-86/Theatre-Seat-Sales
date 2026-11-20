const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require('C:/Users/peter/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:980}});
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    const event = JSON.parse(fs.readFileSync('.taste-skill/live-event.json','utf8'));
    const history = JSON.parse(fs.readFileSync('.taste-skill/live-history.json','utf8'));
    const makeCapture=(extra)=>({captured_at:'2026-11-18T03:00:00Z',cadence:'weekly',...extra});
    const posts=[
      {id:'first',platform:'facebook',post_type:'photo',published_on:'2026-11-17',url:'https://www.facebook.com/reel/123',notes:'Ticket offer',
       campaign_captures:[makeCapture({views:200,engagements:18,likes:12,comments:4,shares:2,clicks:5})]},
      {id:'second',platform:'facebook',post_type:'photo',published_on:'2026-11-16',url:'https://www.facebook.com/reel/234',notes:'Fates photo',
       campaign_captures:[makeCapture({comments:3,shares:16})]},
    ];
    await page.route('http://dashboard.test/**',async route=>{
      const req=route.request(),url=new URL(req.url()),path=url.pathname;
      if(path==='/api/analyse')return route.fulfill({json:event});
      if(path==='/api/history')return route.fulfill({json:history});
      if(path==='/api/campaign'){
        if(req.method()==='POST'){
          const body=req.postDataJSON(), post=posts.find(row=>row.id===body.postId);
          if(body.action==='notes'){post.notes=body.notes.trim();return route.fulfill({json:{post}});}
          if(body.action==='edit'){Object.assign(post,{published_on:body.publishedOn,post_type:body.postType,notes:body.notes});return route.fulfill({json:{post}});}
          if(body.action==='remove'||body.action==='restore'){post.removed=body.action==='remove';return route.fulfill({json:{post}});}
          return route.fulfill({json:{queued:true}});
        }
        if(url.searchParams.has('postId')){
          const post=posts.find(row=>row.id===url.searchParams.get('postId'));
          return route.fulfill({json:{post,captures:post.campaign_captures}});
        }
        return route.fulfill({json:{openingAt:'2027-03-10T08:30:00Z',finishAt:'2027-03-13T11:30:00Z',posts:posts.filter(p=>!p.removed)}});
      }
      const local=path==='/'?'index.html':path.slice(1);
      return fs.existsSync(local)?route.fulfill({path:local}):route.fulfill({status:404});
    });
    await page.goto('http://dashboard.test/?event=162924');
    await page.locator('#event-name').getByText('Finding Nemo JR.').waitFor();
    await page.getByRole('tab',{name:'Campaign',exact:true}).click();
    await page.locator('#campaign-unlock input').fill('test-key');
    await page.getByRole('button',{name:'Open campaign'}).click();
    await page.locator('.campaign-post-row').first().waitFor();
    const rows=page.locator('.campaign-post-row');
    assert.equal(await rows.nth(0).locator('td').nth(3).innerText(),'23');
    assert.equal(await rows.nth(1).locator('td').nth(3).innerText(),'19');
    const mainHead=await page.locator('#campaign-posts').evaluate(body=>Array.from(body.closest('table').tHead.querySelectorAll('th')).map(n=>n.textContent));
    assert.deepEqual(mainHead,['Post','Date posted','Views','Engagements','Last check','Actions']);
    await rows.nth(0).getByRole('button',{name:'Facebook photo',exact:true}).click();
    await page.locator('#campaign-captures tr').waitFor();
    assert.equal(await rows.nth(0).evaluate(row=>row.nextElementSibling.className),'campaign-detail-row');
    await rows.nth(0).getByRole('button',{name:'Facebook photo',exact:true}).click();
    assert.equal(await page.locator('.campaign-detail-row').isVisible(),false);
    await rows.nth(1).locator('td').nth(1).click();
    await page.locator('#campaign-captures tr').waitFor();
    assert.equal(await rows.nth(1).evaluate(row=>row.nextElementSibling.className),'campaign-detail-row');
    assert.equal(await page.locator('#campaign-notes-form textarea').inputValue(),'Fates photo');
    await page.locator('#campaign-notes-form textarea').fill('Corrected Fates photo');
    await page.getByRole('button',{name:'Save notes'}).click();
    await page.getByText('Notes saved.',{exact:true}).waitFor();
    await rows.nth(0).getByRole('button',{name:'Edit',exact:true}).click();
    assert.equal(await rows.nth(0).evaluate(row=>row.nextElementSibling.className),'campaign-detail-row');
    await page.locator('#campaign-edit-form [name=publishedOn]').fill('2026-11-15');
    await page.getByRole('button',{name:'Save changes',exact:true}).click();
    await page.getByText('Entry updated.',{exact:true}).waitFor();
    assert.equal(await rows.nth(0).locator('td').nth(1).innerText(),'15 Nov 2026');
    await rows.nth(0).getByRole('button',{name:'Facebook photo',exact:true}).click();
    await page.locator('#campaign-captures tr').waitFor();
    await page.locator('#campaign-pane').screenshot({path:'.taste-skill/layout-shots/campaign-inline-desktop.png'});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.locator('#campaign-pane').screenshot({path:'.taste-skill/layout-shots/campaign-inline-mobile.png'});
    await rows.nth(0).getByRole('button',{name:'Remove',exact:true}).click();
    await page.getByRole('button',{name:'Undo remove',exact:true}).click();
    await page.getByText('Entry restored.',{exact:true}).waitFor();
    assert.equal(await rows.count(),2);
    assert.deepEqual(errors,[]);
    console.log('Inline expansion/collapse, row click, switching, safe engagement totals, notes, editing, undo and mobile layout passed.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
