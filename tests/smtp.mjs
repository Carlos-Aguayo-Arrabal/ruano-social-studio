import net from 'node:net';
export async function smtpFixture({ reject = false } = {}) {
  const sockets = new Set(), messages = [];
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close',()=>sockets.delete(socket));
    socket.setEncoding('utf8'); socket.write('220 fixture.invalid ESMTP test\r\n');
    let buffer='',inData=false,message='';
    socket.on('data',chunk=>{
      buffer+=chunk;
      while(buffer.includes('\r\n')) {
        const i=buffer.indexOf('\r\n'),line=buffer.slice(0,i);buffer=buffer.slice(i+2);
        if(inData){if(line==='.'){inData=false;messages.push(message);message='';socket.write('250 accepted\r\n');}else message+=line+'\r\n';continue;}
        if(/^EHLO/.test(line))socket.write('250-fixture.invalid\r\n250 AUTH PLAIN\r\n');
        else if(/^AUTH PLAIN /.test(line))socket.write(Buffer.from(line.slice(11),'base64').toString()==='\0fixture-user\0fixture-password'?'235 authenticated\r\n':'535 rejected\r\n');
        else if(/^MAIL FROM/.test(line))socket.write(reject?'550 test rejection\r\n':'250 ok\r\n');
        else if(/^RCPT TO/.test(line))socket.write('250 ok\r\n');
        else if(line==='DATA'){inData=true;socket.write('354 end with dot\r\n');}
        else if(line==='QUIT')socket.end('221 bye\r\n');else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {port:server.address().port,messages,close:async()=>{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}};
}
