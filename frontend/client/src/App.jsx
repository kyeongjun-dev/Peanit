import React, { useState, useEffect, useRef } from 'react'; // useRef 추가
import axios from 'axios';
import './App.css';

function App() {
  const [tickets, setTickets] = useState([]);
  const [title, setTitle] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("연결 중...");
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [isCopied, setIsCopied] = useState(false);

  // ✨ 드래그 중인 항목과 드래그 대상 항목을 추적하기 위한 Ref
  const dragItem = useRef();
  const dragOverItem = useRef();

  const COLUMNS = ["To Do", "In Progress", "Done"];

  const fetchTickets = async () => {
    try {
      const res = await axios.get('http://localhost:8000/api/tickets');
      setTickets(res.data);
    } catch (err) { console.error(err); }
  };

  useEffect(() => {
    fetchTickets();
    const eventSource = new EventSource("http://localhost:8000/stream");
    eventSource.onopen = () => setConnectionStatus("🟢 실시간 연결됨");
    eventSource.addEventListener("ticket_updated", () => fetchTickets());
    eventSource.onerror = () => eventSource.close();
    return () => eventSource.close();
  }, []);

  const createTicket = async () => {
    if (!title) return;
    await axios.post('http://localhost:8000/api/tickets', { title });
    setTitle("");
    fetchTickets(); // 내 화면 즉시 갱신 (SSE 기다리지 않고)
  };

  // --- ✨ 새로운 드래그 앤 드롭 로직 ---

  // 1. 드래그 시작
  const onDragStart = (e, position) => {
    dragItem.current = position; // { status: "To Do", index: 0 } 형태로 저장
  };

  // 2. 다른 카드 위로 드래그 시 (순서 교체)
  const onDragEnter = (e, position) => {
    e.preventDefault(); // 필수
    dragOverItem.current = position;

    const source = dragItem.current;
    const destination = dragOverItem.current;

    // 같은 카드가 아니면 순서 교체 로직 실행
    if (source.index === destination.index && source.status === destination.status) return;

    // React State 내에서 배열 순서를 바꿈 (화면에 즉시 반영)
    const newTickets = [...tickets];

    // 현재 상태(Status)별로 그룹화된 리스트가 아니라, 전체 리스트에서 인덱스를 찾아야 함
    // 편의를 위해 "현재 드래그 중인 티켓 객체"를 찾습니다.
    const draggedTicket = newTickets.find(t => t.status === source.status && newTickets.indexOf(t) === source.globalIndex);

    // 하지만 위 방식은 복잡하므로, 화면에 보이는 리스트 순서를 조작하는 방식을 씁니다.
    // 여기서는 간단하게 "티켓 리스트 전체를 재정렬" 하는 함수를 만듭니다.

    // 1. 원본 복사
    const listCopy = [...tickets];

    // 2. 드래그 중인 아이템 추출
    const draggingItemContent = listCopy[source.globalIndex];

    // 3. 리스트에서 제거
    listCopy.splice(source.globalIndex, 1);

    // 4. 새 위치(목표 아이템의 위치)에 삽입
    // 목표 위치가 다른 컬럼이라면, 상태(status)도 업데이트 해줘야 함
    draggingItemContent.status = destination.status;
    listCopy.splice(destination.globalIndex, 0, draggingItemContent);

    // 5. Ref 업데이트 (이제 내 위치가 바뀌었으므로)
    dragItem.current = { ...destination, globalIndex: destination.globalIndex };
    dragOverItem.current = null; // 초기화

    // 6. State 업데이트
    setTickets(listCopy);
  };

  // 3. 드래그 종료 (서버 저장)
  const onDragEnd = async () => {
    // 현재 tickets 상태는 이미 순서가 바뀌어 있음
    // 이 순서대로 order_index를 매겨서 서버에 전송
    const updatedTickets = tickets.map((t, index) => ({
      key: t.key,
      status: t.status, // 드래그하면서 이미 status는 바뀌어 있음
      order_index: index // 배열 순서대로 0, 1, 2... 부여
    }));

    try {
      await axios.put('http://localhost:8000/api/tickets/batch', updatedTickets);
      console.log("순서 저장 완료");
    } catch (err) {
      console.error("순서 저장 실패", err);
      fetchTickets(); // 실패하면 원복
    }

    dragItem.current = null;
    dragOverItem.current = null;
  };

  // --- 기존 함수들 (모달 등) ---
  const copyBranchCommand = () => {
    if (!selectedTicket) return;
    const command = `git checkout -b feature/${selectedTicket.key}`;
    navigator.clipboard.writeText(command).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 1000);
    });
  };

  const saveTicket = async () => {
    if (!selectedTicket) return;
    try {
      await axios.put(`http://localhost:8000/api/tickets/${selectedTicket.key}`, {
        title: selectedTicket.title,
        content: selectedTicket.content
      });
      fetchTickets();
      setSelectedTicket(null);
    } catch (err) { alert("저장 실패"); }
  };

  // 헬퍼: 티켓의 전체 리스트 내 인덱스 찾기
  const getGlobalIndex = (key) => tickets.findIndex(t => t.key === key);

  return (
    <div style={{ maxWidth: "1200px", margin: "0 auto", padding: "20px", fontFamily: "sans-serif" }}>
      <header style={{ display: "flex", justifyContent: "space-between", marginBottom: "20px" }}>
        <h1 style={{ margin: 0 }}>🚀 My Jira Board</h1>
        <span style={{ fontSize: "14px", color: connectionStatus.includes("🟢") ? "green" : "red" }}>{connectionStatus}</span>
      </header>
      
      <div style={{ display: "flex", gap: "10px", marginBottom: "30px" }}>
        <input style={{ flex: 1, padding: "10px", fontSize: "16px" }} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="새로운 할 일 입력" onKeyDown={(e) => e.key === 'Enter' && createTicket()} />
        <button onClick={createTicket} style={{ padding: "10px 20px", background: "#007bff", color: "white", border: "none", cursor: "pointer" }}>만들기</button>
      </div>

      <div style={{ display: "flex", gap: "20px", height: "calc(100vh - 200px)" }}>
        {COLUMNS.map(status => {
          // 해당 컬럼의 티켓들만 필터링
          const columnTickets = tickets.filter(t => t.status === status);

          return (
            <div
              key={status}
              // 컬럼 자체에 드롭했을 때 (빈 공간) 처리 - 맨 뒤로 보내기 등은 복잡하므로
              // 여기서는 카드 간 교체(Swap) 방식만 사용합니다.
              onDragOver={(e) => e.preventDefault()}
              style={{ flex: 1, background: "#f4f5f7", borderRadius: "8px", padding: "15px", display: "flex", flexDirection: "column" }}
            >
              <h3 style={{ margin: "0 0 15px 0", color: "#5e6c84", fontSize: "14px", textTransform: "uppercase" }}>
                {status} <span style={{background:"#dfe1e6", borderRadius:"10px", padding:"2px 8px", fontSize:"12px"}}>{columnTickets.length}</span>
              </h3>

              <div style={{ overflowY: "auto", flex: 1, minHeight: "100px" }}>
                {columnTickets.map((t, index) => (
                  <div
                    key={t.key}
                    draggable
                    // ✨ 드래그 시작 시: 현재 상태, 컬럼 내 인덱스, 전체 리스트 인덱스를 저장
                    onDragStart={(e) => onDragStart(e, { status, index, globalIndex: getGlobalIndex(t.key) })}
                    // ✨ 다른 카드 위로 올라왔을 때: 순서 교체 시도
                    onDragEnter={(e) => onDragEnter(e, { status, index, globalIndex: getGlobalIndex(t.key) })}
                    // ✨ 드래그 끝났을 때: 서버 저장
                    onDragEnd={onDragEnd}
                    // 클릭 이벤트
                    onClick={() => setSelectedTicket(t)}

                    style={{
                      background: "white", padding: "15px", borderRadius: "4px", marginBottom: "10px",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.1)", cursor: "grab",
                      borderLeft: t.status === "In Progress" ? "4px solid #0052cc" : t.status === "Done" ? "4px solid #00875a" : "4px solid #42526e"
                    }}
                  >
                    <div style={{ fontSize: "12px", color: "#6b778c", marginBottom: "8px", display:"flex", justifyContent:"space-between" }}>
                      <strong>{t.key}</strong>
                      {t.branch_url && <span style={{color:"green", fontWeight:"bold"}}>🌱 연결됨</span>}
                    </div>
                    <div style={{ fontSize: "16px", fontWeight: "bold", color: "#333" }}>{t.title}</div>
                  </div>
                ))}

                {/* 빈 공간 처리: 컬럼에 티켓이 하나도 없거나, 맨 아래로 옮기고 싶을 때를 위한 투명 영역 */}
                {/* 빈 공간 처리: 컬럼에 티켓이 하나도 없거나, 맨 아래로 옮기고 싶을 때 */}
                <div 
                  style={{ height: "100%", flex: 1, minHeight: "50px" }} // minHeight 추가하여 빈 컬럼도 드롭 영역 확보
                  onDragEnter={(e) => {
                    e.preventDefault();

                    // 1. 드래그 중인 아이템이 없으면 무시
                    if (!dragItem.current) return;

                    const source = dragItem.current;
                    const targetStatus = status; // 현재 마우스가 올라온 컬럼의 상태

                    // 2. 이미 같은 컬럼에 있다면 무시 (카드끼리 순서 변경은 위의 카드 onDragEnter에서 처리함)
                    if (source.status === targetStatus) return;

                    // 3. 다른 컬럼으로 이동 로직 실행
                    const newTickets = [...tickets];
                    const draggingItemContent = newTickets[source.globalIndex];

                    // (1) 원래 위치에서 삭제
                    newTickets.splice(source.globalIndex, 1);

                    // (2) 상태 변경
                    draggingItemContent.status = targetStatus;

                    // (3) 리스트 맨 끝에 추가 (빈 컬럼이거나 맨 아래 빈 공간이므로)
                    newTickets.push(draggingItemContent);

                    // (4) Ref 업데이트 (중요: 현재 드래그 중인 아이템의 위치가 바뀌었음을 알림)
                    dragItem.current = {
                      ...source,
                      status: targetStatus,
                      globalIndex: newTickets.length - 1
                    };

                    // (5) 화면 갱신
                    setTickets(newTickets);
                  }}
                ></div>
              </div>
            </div>
          )
        })}
      </div>

      {/* 모달 (기존 코드 유지) */}
      {selectedTicket && (
        <div style={{ position: "fixed", top: 0, left: 0, width: "100%", height: "100%", backgroundColor: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 1000 }} onClick={() => setSelectedTicket(null)}>
          <div style={{ background: "white", width: "600px", padding: "30px", borderRadius: "8px", boxShadow: "0 4px 12px rgba(0,0,0,0.15)", position: "relative" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ marginBottom: "20px", borderBottom: "1px solid #eee", paddingBottom: "10px" }}>
              <span style={{ fontSize: "14px", color: "#5e6c84", fontWeight: "bold" }}>{selectedTicket.key}</span>
              <input type="text" value={selectedTicket.title} onChange={(e) => setSelectedTicket({...selectedTicket, title: e.target.value})} style={{ width: "100%", fontSize: "24px", fontWeight: "bold", border: "none", outline: "none", marginTop: "5px" }} />
            </div>
            <div style={{ background: "#f0f8ff", padding: "15px", borderRadius: "6px", marginBottom: "20px" }}>
              {selectedTicket.branch_url ? (
                <div>
                  <div style={{fontSize: "12px", color: "#5e6c84", marginBottom: "4px"}}>GitHub Branch</div>
                  <a href={selectedTicket.branch_url} target="_blank" rel="noreferrer" style={{ color: "#0052cc", fontWeight: "bold", textDecoration: "none", display: "flex", alignItems: "center", gap: "5px" }}>🌱 {selectedTicket.branch_url.split('/').pop()} 바로가기 ↗</a>
                </div>
              ) : (
                <div style={{ color: "#666", fontSize: "14px" }}>
                  <div style={{marginBottom: "5px"}}>⚠️ 연결된 브랜치가 없습니다.</div>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", background: "white", padding: "8px", borderRadius: "4px", border: "1px solid #ddd" }}>
                    <code style={{ fontFamily: "monospace", color: "#d63384", flex: 1 }}>git checkout -b feature/{selectedTicket.key}</code>
                    <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                      {isCopied && <span style={{ fontSize: "12px", color: "green", fontWeight: "bold" }}>✅ Copied!</span>}
                      <button onClick={copyBranchCommand} style={{ fontSize: "12px", padding: "4px 8px", cursor: "pointer", background: "#eee", border: "1px solid #ccc", borderRadius: "4px" }} title="명령어 복사">📋 복사</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div style={{ marginBottom: "20px" }}>
              <div style={{fontSize: "12px", color: "#5e6c84", marginBottom: "5px", fontWeight: "bold"}}>Description</div>
              <textarea value={selectedTicket.content || ""} onChange={(e) => setSelectedTicket({...selectedTicket, content: e.target.value})} style={{ width: "100%", height: "150px", padding: "10px", borderRadius: "4px", border: "1px solid #dfe1e6", resize: "none", fontSize: "14px" }} placeholder="티켓 내용을 입력하세요..." />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
              <button onClick={() => setSelectedTicket(null)} style={{ padding: "8px 16px", background: "none", border: "none", cursor: "pointer", color: "#42526e" }}>취소</button>
              <button onClick={saveTicket} style={{ padding: "8px 16px", background: "#0052cc", color: "white", border: "none", borderRadius: "4px", cursor: "pointer", fontWeight: "bold" }}>저장하기</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;