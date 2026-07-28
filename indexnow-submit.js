const https = require('https')

const KEY = '1acef751b92a45279133872a0f6f362b'
const HOST = 'parafree.app'

const urls = [
  'https://parafree.app/',
  'https://parafree.app/cv-builder.html',
  'https://parafree.app/code.html',
  'https://parafree.app/best-free-cv-builder.html',
  'https://parafree.app/best-free-paraphrasing-tool.html',
  'https://parafree.app/paraphrase-powerpoint.html',
  'https://parafree.app/paraphrase-word-document.html',
  'https://parafree.app/paraphrase-pdf.html',
  'https://parafree.app/quillbot-alternative.html',
  'https://parafree.app/paraphrasing-tool-no-word-limit.html',
  'https://parafree.app/ai-cv-builder.html',
  'https://parafree.app/cv-builder-no-signup.html',
  'https://parafree.app/ats-resume-builder.html',
  'https://parafree.app/student-cv-builder.html',
  'https://parafree.app/paraphrase-essay.html',
  'https://parafree.app/ai-rephraser.html',
  'https://parafree.app/wordtune-alternative.html',
  'https://parafree.app/cv-maker-free-download.html',
  'https://parafree.app/free-cv-builder-australia.html',
  'https://parafree.app/free-cv-builder-uk.html',
  'https://parafree.app/free-cv-builder-canada.html',
  'https://parafree.app/free-cv-builder-usa.html',
  'https://parafree.app/free-cv-builder-international-students.html',
  'https://parafree.app/free-paraphrasing-tool-students.html',
  'https://parafree.app/free-paraphrasing-tool-australia.html',
  'https://parafree.app/free-paraphrasing-tool-usa.html',
  'https://parafree.app/cv-blog.html',
  'https://parafree.app/blog.html',
  'https://parafree.app/cv-templates.html',
  'https://parafree.app/faq.html',
]

const payload = JSON.stringify({
  host: HOST,
  key: KEY,
  keyLocation: `https://${HOST}/${KEY}.txt`,
  urlList: urls
})

const options = {
  hostname: 'api.indexnow.org',
  port: 443,
  path: '/indexnow',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  }
}

const req = https.request(options, res => {
  console.log('IndexNow status:', res.statusCode)
  let data = ''
  res.on('data', d => data += d)
  res.on('end', () => console.log('Response:', data || 'OK'))
})

req.on('error', e => console.error('Error:', e.message))
req.write(payload)
req.end()
