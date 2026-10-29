import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
const { default: nodemailer } = await import(process.env.NODEMAILER_CANDIDATE ? pathToFileURL(process.env.NODEMAILER_CANDIDATE).href : 'nodemailer');

test('mail compatibility: authenticated SMTP send using synthetic local accounts only', async () => {
  const sockets = new Set(); let received = '', authenticated = false;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close',()=>sockets.delete(socket));
    socket.setEncoding('utf8'); socket.write('220 fixture.invalid ESMTP test\r\n');
    let buffer = '', inData = false;
    socket.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\r\n')) {
        const i = buffer.indexOf('\r\n'), line = buffer.slice(0,i); buffer = buffer.slice(i+2);
        if (inData) { if (line==='.') { inData=false; socket.write('250 accepted\r\n'); } else received += line+'\r\n'; continue; }
        if (/^EHLO/.test(line)) socket.write('250-fixture.invalid\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN /.test(line)) {
          authenticated = Buffer.from(line.slice(11),'base64').toString()==='\0fixture-user\0fixture-password';
          socket.write(authenticated ? '235 authenticated\r\n' : '535 rejected\r\n');
        } else if (/^(MAIL FROM|RCPT TO)/.test(line)) socket.write('250 ok\r\n');
        else if (line==='DATA') { inData=true; socket.write('354 end with dot\r\n'); }
        else if (line==='QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const transport=nodemailer.createTransport({ host:'127.0.0.1',port:server.address().port,secure:false,auth:{user:'fixture-user',pass:'fixture-password'},connectionTimeout:3000,socketTimeout:3000 });
  try {
    const result=await transport.sendMail({from:'Estudio <studio@example.invalid>',to:'Cliente <client@example.invalid>',replyTo:'visitor@example.invalid',subject:'Informe semanal · prueba',text:'Contenido, visitas y contactos. Información sintética.'});
    assert.equal(authenticated,true);assert.deepEqual(result.accepted,['client@example.invalid']);
    assert.match(received,/Reply-To: visitor@example.invalid/i);assert.match(received,/Subject:/);assert.match(received,/Content-Type: text\/plain/);
  } finally {transport.close();for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r));}
});
