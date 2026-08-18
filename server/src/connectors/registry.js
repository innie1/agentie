// ============================================================================
// AGENTIE CONNECTOR REGISTRY
// Real provider execution. No simulated success responses.
// ============================================================================
import axios from "axios";
import { supabaseAdmin } from "../supabaseClient.js";
import { decrypt } from "../lib/crypto.js";

export const CONNECTORS = {
  gmail: { id: "gmail", name: "Gmail", actions: {
    searchEmails: { name: "searchEmails", irreversible: false, description: "Search emails" }, readThread: { name: "readThread", irreversible: false, description: "Read an email thread" }, draftEmail: { name: "draftEmail", irreversible: false, description: "Create an email draft" }, sendEmail: { name: "sendEmail", irreversible: true, description: "Send an email" }
  }},
  gcal: { id: "gcal", name: "Google Calendar", actions: {
    checkAvailability: { name: "checkAvailability", irreversible: false, description: "Check calendar events" }, createMeeting: { name: "createMeeting", irreversible: true, description: "Create a calendar event" }
  }},
  slack: { id: "slack", name: "Slack", actions: {
    readChannel: { name: "readChannel", irreversible: false, description: "Read channel history" }, sendMessage: { name: "sendMessage", irreversible: true, description: "Send a Slack message" }
  }},
  github: { id: "github", name: "GitHub", actions: {
    searchRepos: { name: "searchRepos", irreversible: false, description: "Search repositories" }, readIssue: { name: "readIssue", irreversible: false, description: "Read an issue or pull request" }, createIssue: { name: "createIssue", irreversible: false, description: "Create an issue" }, mergePullRequest: { name: "mergePullRequest", irreversible: true, description: "Merge a pull request" }
  }},
  notion: { id: "notion", name: "Notion", actions: {
    searchPages: { name: "searchPages", irreversible: false, description: "Search Notion" }, readDoc: { name: "readDoc", irreversible: false, description: "Read a Notion page" }, createPage: { name: "createPage", irreversible: false, description: "Create a Notion page" }, deletePage: { name: "deletePage", irreversible: true, description: "Delete a Notion page" }
  }},
  gdrive: { id: "gdrive", name: "Google Drive", actions: {
    searchFiles: { name: "searchFiles", irreversible: false, description: "Search Google Drive" }, getFile: { name: "getFile", irreversible: false, description: "Read Google Drive file metadata or content" }, createFile: { name: "createFile", irreversible: false, description: "Create a Google Drive file" }, updateFile: { name: "updateFile", irreversible: false, description: "Update Google Drive file metadata" }, deleteFile: { name: "deleteFile", irreversible: true, description: "Delete a Google Drive file" }
  }},
  canva: { id: "canva", name: "Canva", actions: {
    searchDesigns: { name: "searchDesigns", irreversible: false, description: "Search the user's Canva designs" }, getDesign: { name: "getDesign", irreversible: false, description: "Get Canva design metadata and links" }, createDesign: { name: "createDesign", irreversible: false, description: "Create a Canva design" }, listBrandTemplates: { name: "listBrandTemplates", irreversible: false, description: "Search accessible Canva brand templates" }, getBrandTemplate: { name: "getBrandTemplate", irreversible: false, description: "Get Canva brand template metadata" }
  }},
  whatsapp: { id: "whatsapp", name: "WhatsApp Business", actions: {
    sendMessage: { name: "sendMessage", irreversible: true, description: "Send a WhatsApp message" }, getBusinessProfile: { name: "getBusinessProfile", irreversible: false, description: "Read WhatsApp business profile" }
  }},
  stripe: { id: "stripe", name: "Stripe", actions: {
    getInvoice: { name: "getInvoice", irreversible: false, description: "Inspect a Stripe invoice" }, createInvoice: { name: "createInvoice", irreversible: false, description: "Create a Stripe draft invoice" }, chargeCustomer: { name: "chargeCustomer", irreversible: true, description: "Create a Stripe payment intent" }
  }},
  shopify: { id: "shopify", name: "Shopify", actions: {
    getShop: { name: "getShop", irreversible: false, description: "Read Shopify shop information" }, searchProducts: { name: "searchProducts", irreversible: false, description: "Search Shopify products" }, searchOrders: { name: "searchOrders", irreversible: false, description: "Search Shopify orders" }, createProduct: { name: "createProduct", irreversible: false, description: "Create a Shopify product" }
  }}
};

async function tokenFor(userId, connectorId) {
  const { data, error } = await supabaseAdmin.from("user_plugins").select("access_token, expires_at, status").eq("user_id", userId).eq("plugin_id", connectorId).maybeSingle();
  if (error) throw new Error(`Unable to load ${connectorId} connection: ${error.message}`);
  if (!data || data.status !== "active") throw new Error(`${connectorId} is not connected for this user`);
  if (!data.access_token) throw new Error(`${connectorId} has no access token`);
  if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) throw new Error(`${connectorId} access token has expired; reconnect the plugin`);
  return decrypt(data.access_token);
}

async function secretFor(userId, connectorId) {
  const { data, error } = await supabaseAdmin.from("user_plugins").select("api_key, status").eq("user_id", userId).eq("plugin_id", connectorId).maybeSingle();
  if (error) throw new Error(`Unable to load ${connectorId} connection: ${error.message}`);
  if (!data || data.status !== "active") throw new Error(`${connectorId} is not connected for this user`);
  if (!data.api_key) throw new Error(`${connectorId} has no API key configured`);
  return decrypt(data.api_key);
}
const auth = token => ({ Authorization: `Bearer ${token}` });

function gmailRaw({ to, subject, body }) { return Buffer.from([`To: ${to}`, `Subject: ${subject || ""}`, "Content-Type: text/plain; charset=utf-8", "", body || ""].join("\r\n")).toString("base64url"); }
async function gmail(a,p,t){const h=auth(t);if(a==="searchEmails"){const r=await axios.get("https://gmail.googleapis.com/gmail/v1/users/me/messages",{headers:h,params:{q:p.query||"",maxResults:p.maxResults||20}});const messages=await Promise.all((r.data.messages||[]).slice(0,20).map(({id})=>axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`,{headers:h,params:{format:"metadata",metadataHeaders:["From","To","Subject","Date"]}}).then(x=>x.data)));return{messages,resultSizeEstimate:r.data.resultSizeEstimate||0};}if(a==="readThread")return(await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(p.threadId)}`,{headers:h,params:{format:"full"}})).data;if(a==="draftEmail")return(await axios.post("https://gmail.googleapis.com/gmail/v1/users/me/drafts",{message:{raw:gmailRaw(p)}},{headers:{...h,"Content-Type":"application/json"}})).data;if(a==="sendEmail")return(await axios.post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send",{raw:gmailRaw(p)},{headers:{...h,"Content-Type":"application/json"}})).data;}
async function gcal(a,p,t){const h=auth(t);if(a==="checkAvailability")return{events:(await axios.get("https://www.googleapis.com/calendar/v3/calendars/primary/events",{headers:h,params:{timeMin:p.timeMin,timeMax:p.timeMax,singleEvents:true,orderBy:"startTime",maxResults:p.maxResults||100}})).data.items||[]};if(a==="createMeeting")return(await axios.post("https://www.googleapis.com/calendar/v3/calendars/primary/events",{summary:p.summary,description:p.description,start:p.start,end:p.end,attendees:(p.attendees||[]).map(e=>typeof e==="string"?{email:e}:e)},{headers:{...h,"Content-Type":"application/json"}})).data;}
async function slack(a,p,t){const h={...auth(t),"Content-Type":"application/json; charset=utf-8"};if(a==="readChannel"){const r=await axios.get("https://slack.com/api/conversations.history",{headers:h,params:{channel:p.channelId,limit:p.limit||50,cursor:p.cursor}});if(!r.data.ok)throw new Error(r.data.error||"Slack history request failed");return r.data;}if(a==="sendMessage"){const r=await axios.post("https://slack.com/api/chat.postMessage",{channel:p.channelId,text:p.text,thread_ts:p.threadTs},{headers:h});if(!r.data.ok)throw new Error(r.data.error||"Slack send failed");return r.data;}}
async function github(a,p,t){const h={...auth(t),Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"};if(a==="searchRepos")return(await axios.get("https://api.github.com/search/repositories",{headers:h,params:{q:p.query,per_page:p.perPage||20}})).data;if(a==="readIssue")return(await axios.get(`https://api.github.com/repos/${p.owner}/${p.repo}/issues/${p.issueNumber}`,{headers:h})).data;if(a==="createIssue")return(await axios.post(`https://api.github.com/repos/${p.owner}/${p.repo}/issues`,{title:p.title,body:p.body,labels:p.labels},{headers:h})).data;if(a==="mergePullRequest")return(await axios.put(`https://api.github.com/repos/${p.owner}/${p.repo}/pulls/${p.pullNumber}/merge`,{commit_title:p.commitTitle,commit_message:p.commitMessage,merge_method:p.mergeMethod||"merge"},{headers:h})).data;}
async function notion(a,p,t){const h={...auth(t),"Content-Type":"application/json","Notion-Version":"2022-06-28"};if(a==="searchPages")return(await axios.post("https://api.notion.com/v1/search",{query:p.query||"",page_size:p.pageSize||20},{headers:h})).data;if(a==="readDoc")return(await axios.get(`https://api.notion.com/v1/pages/${p.pageId}`,{headers:h})).data;if(a==="createPage")return(await axios.post("https://api.notion.com/v1/pages",{parent:p.parent,properties:p.properties,children:p.children},{headers:h})).data;if(a==="deletePage")return(await axios.patch(`https://api.notion.com/v1/pages/${p.pageId}`,{archived:true},{headers:h})).data;}
async function gdrive(a,p,t){const h=auth(t);if(a==="searchFiles")return(await axios.get("https://www.googleapis.com/drive/v3/files",{headers:h,params:{q:p.query||"trashed = false",pageSize:p.pageSize||50,fields:"files(id,name,mimeType,size,modifiedTime,webViewLink,parents),nextPageToken"}})).data;if(a==="getFile")return(await axios.get(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(p.fileId)}`,{headers:h,params:{alt:p.download?"media":"json",fields:p.download?undefined:"id,name,mimeType,size,modifiedTime,webViewLink"}})).data;if(a==="createFile")return(await axios.post("https://www.googleapis.com/drive/v3/files",{name:p.name,mimeType:p.mimeType,parents:p.parents},{headers:{...h,"Content-Type":"application/json"},params:{fields:"id,name,mimeType,webViewLink"}})).data;if(a==="updateFile")return(await axios.patch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(p.fileId)}`,{name:p.name,description:p.description},{headers:{...h,"Content-Type":"application/json"},params:{fields:"id,name,mimeType,modifiedTime,webViewLink"}})).data;if(a==="deleteFile")return(await axios.delete(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(p.fileId)}`,{headers:h})).data;}
async function canva(a,p,t){const h=auth(t);if(a==="searchDesigns")return(await axios.get("https://api.canva.com/rest/v1/designs",{headers:h,params:{query:p.query,limit:p.limit||25,continuation:p.continuation}})).data;if(a==="getDesign")return(await axios.get(`https://api.canva.com/rest/v1/designs/${encodeURIComponent(p.designId)}`,{headers:h})).data;if(a==="createDesign")return(await axios.post("https://api.canva.com/rest/v1/designs",{design:p.design,asset_id:p.assetId,brand_template_id:p.brandTemplateId},{headers:{...h,"Content-Type":"application/json"}})).data;if(a==="listBrandTemplates")return(await axios.get("https://api.canva.com/rest/v1/brand-templates",{headers:h,params:{query:p.query,limit:p.limit||25,continuation:p.continuation}})).data;if(a==="getBrandTemplate")return(await axios.get(`https://api.canva.com/rest/v1/brand-templates/${encodeURIComponent(p.brandTemplateId)}`,{headers:h})).data;}
function parseSecret(raw){try{return JSON.parse(raw);}catch{return{key:raw};}}
async function whatsapp(a,p,raw){const c=parseSecret(raw),token=c.accessToken||c.access_token||c.key,id=c.phoneNumberId||c.phone_number_id;if(!token||!id)throw new Error("WhatsApp requires accessToken and phoneNumberId in the connected credential");const base=`https://graph.facebook.com/v23.0/${encodeURIComponent(id)}`;if(a==="sendMessage")return(await axios.post(`${base}/messages`,{messaging_product:"whatsapp",recipient_type:"individual",to:p.to,type:"text",text:{preview_url:!!p.previewUrl,body:p.text}},{headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"}})).data;if(a==="getBusinessProfile")return(await axios.get(`${base}/whatsapp_business_profile`,{headers:{Authorization:`Bearer ${token}`},params:{fields:"about,address,description,email,profile_picture_url,websites,vertical"}})).data;}
async function stripe(a,p,raw){const c=parseSecret(raw),key=c.key||c.apiKey||c.api_key;if(!key)throw new Error("Stripe requires an API key");const h={Authorization:`Bearer ${key}`};if(a==="getInvoice")return(await axios.get(`https://api.stripe.com/v1/invoices/${encodeURIComponent(p.invoiceId)}`,{headers:h})).data;if(a==="createInvoice")return(await axios.post("https://api.stripe.com/v1/invoices",new URLSearchParams({customer:p.customerId,collection_method:p.collectionMethod||"send_invoice",days_until_due:String(p.daysUntilDue||30),description:p.description||""}),{headers:{...h,"Content-Type":"application/x-www-form-urlencoded"}})).data;if(a==="chargeCustomer")return(await axios.post("https://api.stripe.com/v1/payment_intents",new URLSearchParams({amount:String(p.amount),currency:p.currency||"usd",customer:p.customerId||"",payment_method:p.paymentMethodId||"",confirm:p.confirm?"true":"false"}),{headers:{...h,"Content-Type":"application/x-www-form-urlencoded"}})).data;}
async function shopify(a,p,raw){const c=parseSecret(raw),token=c.accessToken||c.access_token||c.key,shop=c.shop||c.shopDomain||c.store;if(!token||!shop)throw new Error("Shopify requires accessToken and shop domain in the connected credential");const host=String(shop).replace(/^https?:\/\//,"").replace(/\/$/,"");const url=`https://${host}/admin/api/2026-01/graphql.json`,h={"Content-Type":"application/json","X-Shopify-Access-Token":token};const q=async(query,variables={})=>{const r=await axios.post(url,{query,variables},{headers:h});if(r.data.errors?.length)throw new Error(r.data.errors.map(e=>e.message).join("; "));return r.data.data;};if(a==="getShop")return q(`query { shop { id name url myshopifyDomain } }`);if(a==="searchProducts")return q(`query($query:String){products(first:50,query:$query){edges{node{id title handle status totalInventory}}}}`,{query:p.query||""});if(a==="searchOrders")return q(`query($query:String){orders(first:50,query:$query){edges{node{id name createdAt displayFinancialStatus displayFulfillmentStatus totalPriceSet{shopMoney{amount currencyCode}}}}}}`,{query:p.query||""});if(a==="createProduct")return q(`mutation($input:ProductCreateInput!){productCreate(product:$input){product{id title handle status}userErrors{field message}}}`,{input:{title:p.title,descriptionHtml:p.descriptionHtml,vendor:p.vendor,productType:p.productType}});}

export async function runAction(connectorId, actionName, params = {}, context = {}) {
  const connector = CONNECTORS[connectorId]; if (!connector) throw new Error(`Connector '${connectorId}' not found in registry.`);
  const action = connector.actions[actionName]; if (!action) throw new Error(`Action '${actionName}' not supported by connector '${connectorId}'.`);
  if (!context.userId) throw new Error("Connector action requires an authenticated user");
  let data;
  if (["whatsapp","stripe","shopify"].includes(connectorId)) {
    const secret = await secretFor(context.userId, connectorId);
    if (connectorId === "whatsapp") data = await whatsapp(actionName, params, secret);
    if (connectorId === "stripe") data = await stripe(actionName, params, secret);
    if (connectorId === "shopify") data = await shopify(actionName, params, secret);
  } else {
    const token = await tokenFor(context.userId, connectorId);
    switch (connectorId) {
      case "gmail": data = await gmail(actionName, params, token); break;
      case "gcal": data = await gcal(actionName, params, token); break;
      case "slack": data = await slack(actionName, params, token); break;
      case "github": data = await github(actionName, params, token); break;
      case "notion": data = await notion(actionName, params, token); break;
      case "gdrive": data = await gdrive(actionName, params, token); break;
      case "canva": data = await canva(actionName, params, token); break;
      default: throw new Error(`Real execution is not wired for '${connectorId}' yet`);
    }
  }
  return { success: true, connector: connectorId, action: actionName, executedAt: new Date().toISOString(), data };
}
