import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../supabaseClient';

const configuration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302'

  }, {
    username: "BhK7h8jJH5QtYa7QyWf322arOW9urwJ0mWxEgG0tEGp3s3M5LAoF_pcPMRS2AXPlAAAAAGha4_VzYXBoYWwyOQ==",
     credential: "dc66537c-5122-11f0-bbb0-0242ac140004",
      urls: [ "turn:bn-turn1.xirsys.com:80?transport=udp",
         "turn:bn-turn1.xirsys.com:3478?transport=udp",
         "turn:bn-turn1.xirsys.com:80?transport=tcp",
         "turn:bn-turn1.xirsys.com:3478?transport=tcp",
         "turns:bn-turn1.xirsys.com:443?transport=tcp",
         "turns:bn-turn1.xirsys.com:5349?transport=tcp" ]}]
};

export default function Call() {
  const { sessionId } = useParams();
  const localVideoRef = useRef();
  const remoteVideoRef = useRef();
  const pc = useRef(null);
  const iceQueue = useRef([]);
  const localIceQueue = useRef([]);
  const channelRef = useRef(null);
  const [isCaller, setIsCaller] = useState(false);
  const [sessionEstablished, setSessionEstablished] = useState(false);

  useEffect(() => {
    let remoteAnswerSet = false;
    let answerInterval = null;

    const setup = async () => {
      try {
        // Close old pc if exists before creating new one
        if (pc.current) {
          pc.current.close();
          pc.current = null;
        }

        pc.current = new RTCPeerConnection(configuration);

        // Get user media
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideoRef.current.srcObject = stream;
        stream.getTracks().forEach(track => pc.current.addTrack(track, stream));

        pc.current.ontrack = (event) => {
          remoteVideoRef.current.srcObject = event.streams[0];
        };

        pc.current.onicecandidate = async (e) => {
          if (e.candidate) {
            if (sessionEstablished) {
              try {
                await supabase.from('ice_candidates').insert({
                  session_id: sessionId,
                  candidate: JSON.stringify(e.candidate)
                });
              } catch (error) {
                console.error('Error inserting ICE candidate:', error);
              }
            } else {
              // Queue local ICE candidates if session is not yet established in DB
              console.log('Queuing local ICE candidate because session is not yet established.');
              localIceQueue.current.push(e.candidate);
            }
          }
        };

        // Check if call session already exists
        const { data: offerRows, error } = await supabase
          .from('call_sessions')
          .select('*')
          .eq('id', sessionId)
          .limit(1);

        if (error && error.code !== 'PGRST116') {
          console.error('Error fetching session:', error.message, error.code);
        }

        const offerRow = offerRows ? offerRows[0] : null;

        if (offerRow) {
          // Joiner role: set remote offer, create answer
          console.log('[Joiner] Offer found, creating answer...');
          setIsCaller(false);
          await pc.current.setRemoteDescription(new RTCSessionDescription(JSON.parse(offerRow.offer)));
          const answer = await pc.current.createAnswer();
          await pc.current.setLocalDescription(answer);
          await supabase.from('call_sessions').update({ answer: JSON.stringify(answer) }).eq('id', sessionId);
          setSessionEstablished(true); // Session established for joiner
        } else {
          // Caller role: create offer and new session
          console.log('[Caller] No offer found, creating new session...');
          setIsCaller(true);
          const offer = await pc.current.createOffer();
          await pc.current.setLocalDescription(offer);
          await supabase.from('call_sessions').upsert({ id: sessionId, offer: JSON.stringify(offer) }, { onConflict: 'id' });
          setSessionEstablished(true); // Session established for caller
        }

        // Drain the local ICE queue after session is established
        while (localIceQueue.current.length > 0) {
          const candidate = localIceQueue.current.shift();
          try {
            await supabase.from('ice_candidates').insert({
              session_id: sessionId,
              candidate: JSON.stringify(candidate)
            });
          } catch (error) {
            console.error('Error inserting queued local ICE candidate:', error);
          }
        }

        // Setup Supabase channel subscription once
        if (!channelRef.current) {
          channelRef.current = supabase
            .channel(`call_${sessionId}`)
            .on('postgres_changes', {
              event: 'INSERT',
              schema: 'public',
              table: 'ice_candidates',
              filter: `session_id=eq.${sessionId}`
            }, async (payload) => {
              const candidate = new RTCIceCandidate(payload.new.candidate);
              if (pc.current.remoteDescription) {
                await pc.current.addIceCandidate(candidate);
              } else {
                iceQueue.current.push(candidate);
              }
            });
          await channelRef.current.subscribe();
        }

        // Caller polls for answer until it arrives, then sets remote description once
        if (!offerRow) {
          answerInterval = setInterval(async () => {
            const { data } = await supabase
              .from('call_sessions')
              .select('answer')
              .eq('id', sessionId)
              .single();

            if (data?.answer && !remoteAnswerSet) {
              try {
                if (
                  pc.current.signalingState === 'stable' ||
                  pc.current.signalingState === 'have-local-offer'
                ) {
                  console.log('[Caller] Answer received');
                  await pc.current.setRemoteDescription(new RTCSessionDescription(JSON.parse(data.answer)));
                  remoteAnswerSet = true;

                  // Add queued ICE candidates now
                  while (iceQueue.current.length) {
                    await pc.current.addIceCandidate(iceQueue.current.shift());
                  }

                  clearInterval(answerInterval);
                }
              } catch (error) {
                console.error('[Caller] Error setting remote answer SDP:', error);
              }
            }
          }, 500);
        }
      } catch (err) {
        console.error('[setup error]', err);
      }
    };

    setup();

    return () => {
      if (channelRef.current) {
        channelRef.current.unsubscribe();
        channelRef.current = null;
      }
      if (answerInterval) clearInterval(answerInterval);

      if (pc.current) {
        pc.current.close();
        pc.current = null;
      }
    };
  }, [sessionId]);

  return (
    <div className="p-4 text-center">
      <h2 className="text-lg mb-2">Session ID: {sessionId}</h2>
      <div className="flex justify-center">
        <video ref={localVideoRef} autoPlay muted className="w-1/2 border m-2" />
        <video ref={remoteVideoRef} autoPlay className="w-1/2 border m-2" />
      </div>
    </div>
  );
}