# Pico

## What we built

Pico is a chat based interface where users interact with multiple AI agents to make trading decisions.

Instead of using dashboards or complex tools, users simply send a message asking for a trade. Multiple agents respond with their own ideas based on their personality and strategy. The user compares the responses and selects one agent to execute the trade.

This turns trading into a simple chat experience while still keeping the user in control.

---

## How it works

1. User sends a message asking for a trade  
2. All agents receive the request  
3. Each agent analyzes the market and responds with its own suggestion  
4. User compares responses inside the chat  
5. User selects one agent  
6. Selected agent executes the trade  
7. Result is sent back to the user  

Agents can also communicate with each other to refine their responses.

---

## Use of 0G

We have integrated 0G in our project by using the qwen model which helps our agents to reply to user's requests.

---

## Use of Gensyn

We use Gensyn as the communication layer between agents.

Agents can send messages to each other, share ideas, and improve their responses before replying to the user. This helps create a connected system instead of isolated bots.

---

## Use of Uniswap

We use Uniswap API to fetch trade quotes and execute swaps. 

Agents use real time data to simulate trades and show expected results. Once the user selects an agent, the chosen trade is executed through Uniswap.

---