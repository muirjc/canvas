# Choosing a diagram type

When you create a diagram, you pick its **type**. The type decides which shapes, connectors and
rules the editor offers, and which kind of [Mermaid](https://mermaid.js.org/) text Canvas writes. You
can't change a diagram's type later, so it's worth a moment's thought.

This page describes the types Canvas comes with. Beside each type's name, the New Diagram dialog shows
the personas it's meant for (Business, Enterprise, Solution or Technical). Types for your own personas
are listed first.

Your admin may have hidden some of these types, renamed them, or added your organisation's own. A
type your organisation added isn't described here: ask your admin what it's for.

**Not sure where to start?**
- To show **what a business does or how it delivers value**, see
  [Business and strategy](#business-and-strategy).
- To show **the applications an organisation runs or plans**, see
  [Enterprise](#enterprise).
- To show **how a software system is built**, start with a [C4 Context](#c4-context) diagram and
  zoom in from there.
- To show **how something behaves over time**, use a [Sequence Diagram](#sequence-diagram) or a
  [State Diagram](#state-diagram).
- To show **data or code structure**, use an [Entity-Relationship Diagram](#entity-relationship-diagram)
  or a [UML Class Diagram](#uml-class-diagram).
- To show **where things run**, use a [Deployment Diagram](#deployment-diagram), a
  [Cloud Infrastructure Diagram](#cloud-infrastructure-diagram), a [Network Diagram](#network-diagram)
  or a [C4 Deployment](#c4-deployment) diagram.
- **For anything else**, use a [Generic Flowchart](#generic-flowchart).

One diagram can link to another, so you can draw the big picture once and link each part to a more
detailed diagram (see [Linked diagrams](editor.md#linked-diagrams)).

## Business and strategy

### Business Capability Map

**For:** Business architects.

**What it shows:** what the business does (not how it does it), as a hierarchy of capabilities.
Level-1 capabilities are groups. Their level-2 and level-3 capabilities sit inside them.

**Use it to:** agree a shared picture of the business, and as a map to place applications,
investment or problems on.

**Example:** "Customer Management" containing "Onboarding", "Billing" and "Support".

Name capabilities as nouns ("Customer Management"), not as processes ("Manage customers").

### Value Chain

**For:** Business and Enterprise architects.

**What it shows:** Porter's value chain:
- the **primary activities** that create and deliver value, left to right (inbound logistics,
  operations, outbound logistics, marketing and sales, service);
- the **support activities** beneath them that help across the whole chain (infrastructure, people,
  technology, procurement);
- the **margin** at the end.

**Use it to:** see where an organisation creates value and where it spends effort to support that.

**Value Chain or Value Stream?** A value chain shows the organisation's activities in general. A value
stream follows one customer outcome from start to finish.

### Value Stream Diagram

**For:** Business architects.

**What it shows:** the end-to-end stages that deliver one outcome to a customer, left to right, from
what starts it to the value delivered.

**Use it to:** find delays, hand-offs and the capabilities each stage needs.

**Example:** "Order Placed" → "Order Confirmed" → "Order Shipped" → "Order Fulfilled".

Draw each stage as a **Chevron** shape and name it as an outcome ("Order Fulfilled").

### Wardley Map

**For:** Business and Enterprise architects.

**What it shows:** a map that starts from a user need at the top and shows the components that meet
it:
- **Higher up** means more visible to the user.
- **Left to right** shows how evolved each component is, from Genesis (new and uncertain) through
  Custom Built and Product to Commodity (standard and cheap).

**Use it to:** decide what to build, buy or outsource, and to show how the landscape is expected to
change, with evolve arrows, inertia and notes.

**Example:** "Customer wants a cup of tea" at the top, then Cup, Tea and Hot Water, with Kettle and
Power below them.

See [Wardley maps](editor.md#wardley-maps) for how the editor works for this type.

## Enterprise

### Application/Enterprise Landscape

**For:** Enterprise architects.

**What it shows:** the organisation's applications, grouped by business domain or capability, and the
main integrations between them.

**Use it to:** take stock of what exists, spot duplication, and plan rationalisation.

**Example:** a "Finance" group holding the ERP and the expenses app, linked to the HR system by
"Employee data".

Label each integration with the data or interface it carries.

### Roadmap

**For:** Enterprise architects.

**What it shows:** initiatives and milestones over time, left to right, usually in lanes (one per
theme or team), with connectors for the dependencies between them.

**Use it to:** show what changes when, and what has to happen first.

**Example:** a "Data platform" lane with "Pick a warehouse" (Q1), then "Migrate reporting" (Q2),
which "Retire the old warehouse" (Q3) depends on.

## Software systems (C4)

The [C4 model](https://c4model.com/) describes a software system at several levels, each zooming
into one part of the level above:
- **Context:** the system and the world around it.
- **Container:** the applications and data stores the system is made of.
- **Component:** the parts inside one container.
- **Code:** the code inside one component.

Start at Context and go only as deep as your readers need. When you link a shape to another diagram,
Canvas suggests the next C4 level down.

### C4 Context

**For:** Solution and Technical architects.

**What it shows:** one software system as a single box, the people who use it, and the other systems
it talks to.

**Use it to:** explain what the system is and who and what it touches. Non-technical readers can
follow it.

**Example:** an "Online Banking" system used by a "Customer", sending email through an external
"Email Service" and reading accounts from the "Core Banking System".

### C4 Container

**For:** Solution and Technical architects.

**What it shows:** the inside of one system: the applications, services and data stores it's made of
(each separately deployable or run), and how they talk to each other and to the outside world.

**Use it to:** show the main technology choices and responsibilities.

**Example:** "Online Banking" as a web app, a mobile app, an API and a database.

"Container" here means any separately run part, not only a Docker container.

### C4 Component

**For:** Technical architects.

**What it shows:** the inside of one container: its main components (groups of related code behind
an interface) and how they work together.

**Use it to:** guide developers working in that container.

**Example:** the banking API's "Sign-in Controller", "Accounts Controller" and "Security Component".

### C4 Code

**For:** Technical architects.

**What it shows:** the inside of one component: its main classes, modules or functions.

**Use it to:** explain a part of the code that is complex or important. Most teams draw this level
only for those parts, or not at all.

For full class detail (attributes, methods, inheritance), a
[UML Class Diagram](#uml-class-diagram) may fit better.

### C4 Deployment

**For:** Technical architects.

**What it shows:** where the containers from a C4 Container diagram run in one environment, such as
live or test. It shows the servers, clusters, cloud services and regions as nested deployment nodes.

**Use it to:** connect the C4 picture to real infrastructure.

**C4 Deployment or Deployment Diagram?** Use C4 Deployment when the rest of your design is in C4.
Use a [Deployment Diagram](#deployment-diagram) for an icon-based picture of the same thing.

## Solution and software design

### Solution Architecture

**For:** Solution architects.

**What it shows:** the components of one solution, the platforms and services it runs on, and the
integrations between them. It can use the Azure and AWS icons.

**Use it to:** give a project a single picture of its solution, more freely drawn than C4.

**Example:** a customer portal on an Azure App Service, calling an API Management gateway in front of
two back-end services.

Label each connection with its protocol or the data it carries.

### Sequence Diagram

**For:** Solution and Technical architects.

**What it shows:** the messages exchanged between participants (people, systems or services) in
order, top to bottom, including loops, alternatives and replies.

**Use it to:** describe one scenario step by step: a sign-in, a payment, an API call and its error
cases.

**Example:** Customer → Web App: "Pay". Web App → Payment Service: "Charge card". Payment Service →
Web App: "Approved".

Canvas lays a sequence diagram out from the order of its messages, so you don't place shapes by hand.

### State Diagram

**For:** Solution and Technical architects.

**What it shows:** the states one thing can be in, and the events that move it from one state to
another, with start and end points, choices and parallel regions.

**Use it to:** pin down a lifecycle: an order, an account, a document's approval.

**Example:** Draft → Submitted → Approved or Rejected; Rejected → Draft.

**State Diagram or Sequence Diagram?** A state diagram follows one thing through its life. A sequence
diagram follows several participants through one scenario.

### Entity-Relationship Diagram

**For:** Solution and Technical architects.

**What it shows:** the entities in a data model, their attributes (with primary and foreign keys),
and the relationships between them with their cardinality (one-to-one, one-to-many, many-to-many).

**Use it to:** design or document a database or a logical data model.

**Example:** a Customer places zero or more Orders; each Order contains one or more Order Lines.

### UML Class Diagram

**For:** Solution and Technical architects.

**What it shows:** classes with their attributes and methods, and how they relate: inheritance,
composition, aggregation, association and dependency, grouped into namespaces.

**Use it to:** design or explain an object model or the structure of a codebase.

**Example:** "Car" and "Truck" inherit from "Vehicle", and a "Garage" holds many Vehicles.

## Infrastructure

These three types are drawn as services, devices and groups with icons. They can use Mermaid's
built-in architecture icons as well as the Azure and AWS icons.

### Deployment Diagram

**For:** Technical architects.

**What it shows:** where software runs: environments and hosting platforms as groups, the services
deployed into them, and how they connect.

**Use it to:** show operations teams what goes where.

**Example:** a "Production" group with a web server, an app server and a database server.

### Cloud Infrastructure Diagram

**For:** Technical architects.

**What it shows:** cloud resources grouped by subscription or account, region and network, drawn
with the provider's official icons.

**Use it to:** document a cloud estate, or plan one.

**Example:** an Azure subscription with a virtual network holding App Service, Azure SQL and a Key
Vault.

### Network Diagram

**For:** Technical architects.

**What it shows:** network zones (such as the internet, a DMZ and the internal network) as groups, the
services and devices in each, and the connections between them.

**Use it to:** review security boundaries and traffic paths.

**Example:** the internet, then a firewall, then a load balancer in the DMZ, then the app servers on
the internal network.

## Anything else

### Generic Flowchart

**For:** every persona.

**What it shows:** boxes, decisions and arrows, with every flowchart shape and no rules beyond your
organisation's standard.

**Use it to:** draw a process, a decision tree, or anything that doesn't fit another type.

**Example:** "Request received", then a decision "Approved?", then "Yes" → "Fulfil" and "No" →
"Notify requester".

If a more specific type fits, choose it instead: its shapes and checks are made for that kind of
diagram.
