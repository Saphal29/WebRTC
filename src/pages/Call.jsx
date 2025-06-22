import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../supabaseClient';

const configuration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

export default function Call() {
  const { sessionId } = useParams();
  const localVideoRef = useRef();
  const remoteVideoRef = useRef();
  const pc = useRef(new RTCPeerConnection(configuration));
  const [isCaller, setIsCaller] = useState(false);
  const iceQueue = useRef([]); // Queue ICE candidates

  useEffect(() => {
    const setup = async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideoRef.current.srcObject = stream;
      stream.getTracks().forEach(track => pc.current.addTrack(track, stream));

      pc.current.ontrack = (event) => {
        remoteVideoRef.current.srcObject = event.streams[0];
      };

      pc.current.onicecandidate = async (e) => {
        if (e.candidate) {
          await supabase.from('ice_candidates').insert({
            session_id: sessionId,
            candidate: JSON.stringify(e.candidate)
          });
        }
      };

      const { data: offerRow } = await supabase
        .from('call_sessions')
        .select('*')
        .eq('id', sessionId)
        .single();

      if (offerRow) {
        setIsCaller(false);
        await pc.current.setRemoteDescription(new RTCSessionDescription(JSON.parse(offerRow.offer)));
        const answer = await pc.current.createAnswer();
        await pc.current.setLocalDescription(answer);
        await supabase.from('call_sessions').update({ answer: JSON.stringify(answer) }).eq('id', sessionId);
      } else {
        setIsCaller(true);
        const offer = await pc.current.createOffer();
        await pc.current.setLocalDescription(offer);
        await supabase.from('call_sessions').insert({ id: sessionId, offer: JSON.stringify(offer) });
      }

      const channel = supabase
        .channel(`call_${sessionId}`)
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'ice_candidates',
          filter: `session_id=eq.${sessionId}`
        }, async (payload) => {
          const candidate = new RTCIceCandidate(JSON.parse(payload.new.candidate));
          if (pc.current.remoteDescription) {
            await pc.current.addIceCandidate(candidate);
          } else {
            iceQueue.current.push(candidate);
          }
        });

      await channel.subscribe();

      // Poll for answer if not the caller
      if (!isCaller) {
        const interval = setInterval(async () => {
          const { data } = await supabase
            .from('call_sessions')
            .select('*')
            .eq('id', sessionId)
            .single();

          if (data?.answer) {
            await pc.current.setRemoteDescription(new RTCSessionDescription(JSON.parse(data.answer)));

            // Apply any queued ICE candidates
            while (iceQueue.current.length) {
              await pc.current.addIceCandidate(iceQueue.current.shift());
            }

            clearInterval(interval);
          }
        }, 500);
      }

      return () => {
        channel.unsubscribe();
      };
    };

    setup();
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
