# Escucha social automática · guía de instalación

El robot de escucha vive en Google Apps Script, un servicio gratuito de Google. Una vez instalado trabaja solo, aunque nadie tenga el tablero abierto.

- Cada 3 horas busca menciones de cada cliente activo, las valora con Gemini y las carga en la solapa **Menciones**.
- Todos los días a las 7 escribe el **resumen del día anterior**.
- Todos los lunes a las 8 escribe el **informe de la semana**.

La instalación lleva unos 15 minutos y se hace una sola vez. Hay que hacerla con **la misma cuenta de Google que creó el proyecto de Firebase** del tablero.

---

## Parte 1 · Lo básico (gratis)

Con esta parte ya funcionan diarios, revistas, medios digitales, YouTube y los comentarios de YouTube.

### Paso 1 · Crear el proyecto del robot

1. Entrá a [Google Apps Script](https://script.google.com) con la cuenta dueña de Firebase.
2. Tocá **Nuevo proyecto**.
3. Arriba a la izquierda, donde dice "Proyecto sin título", escribí **Escucha Creativa**.

### Paso 2 · Pegar el código

1. En el menú de la izquierda tocá el engranaje **Configuración del proyecto**.
2. Tildá **Mostrar el archivo de manifiesto "appsscript.json" en el editor**.
3. Volvé al editor con el ícono **< >** de la izquierda.
4. Abrí el archivo **appsscript.json**, borrá todo y pegá el contenido del archivo [appsscript.json](appsscript.json) de esta carpeta.
5. Abrí el archivo **Código.gs**, borrá todo y pegá el contenido del archivo [robot.gs](robot.gs) de esta carpeta.
6. Tocá el ícono del disquete para guardar.

> Para copiar un archivo desde GitHub, abrilo y tocá el botón de copiar que aparece arriba a la derecha del código.

### Paso 3 · Cargar la clave de Gemini

Gemini es la inteligencia artificial que lee cada mención, decide si es positiva, neutra o negativa y escribe los resúmenes.

1. Entrá a [Google AI Studio](https://aistudio.google.com/app/apikey) y tocá **Crear clave de API**. Copiala.
2. En Apps Script, volvé a **Configuración del proyecto**.
3. Bajá hasta **Propiedades de la secuencia de comandos** y tocá **Agregar propiedad**.
4. En **Propiedad** escribí `GEMINI_KEY` y en **Valor** pegá la clave.
5. Tocá **Guardar propiedades de la secuencia de comandos**.

### Paso 4 · Encender el robot

1. Volvé al editor. Arriba, al lado de **Ejecutar**, elegí la función **instalar** en la lista.
2. Tocá **Ejecutar**.
3. Google pide permiso. Tocá **Revisar permisos** y elegí tu cuenta.
4. Si aparece "Google no verificó esta app", tocá **Configuración avanzada** y después **Ir a Escucha Creativa**. Es normal, porque el robot es tuyo y no está publicado.
5. Tocá **Permitir**.

Abajo aparece el registro. Tiene que decir que la clave de Gemini está cargada y listar los clientes con escucha activa.

### Paso 5 · Probar sin esperar

Elegí la función **probarAhora** y tocá **Ejecutar**. En uno o dos minutos van a aparecer menciones nuevas en el tablero, marcadas como **Escucha automática**.

### Paso 6 · Revisar el tablero

En la solapa **Menciones** de cada cliente

- Completá el **Radar de búsqueda**. El robot usa esos términos. Si el nombre del cliente se confunde con otra persona, agregá palabras de contexto (ciudad, cargo, partido) o palabras para excluir.
- En **Escucha automática** vas a ver el estado de cada fuente. Con **Configurar** podés pausar la escucha de un cliente.

---

## Parte 2 · Facebook e Instagram propios (gratis)

Lee los comentarios que dejan en las páginas del cliente. Necesita que la cuenta tenga rol de administrador en esas páginas.

1. Entrá a [Meta for Developers](https://developers.facebook.com/apps) y creá una app de tipo **Empresa**.
2. En el [Explorador de la API Graph](https://developers.facebook.com/tools/explorer) elegí esa app y pedí un token de usuario con los permisos `pages_show_list`, `pages_read_engagement`, `pages_read_user_content`, `instagram_basic` e `instagram_manage_comments`.
3. Pasá ese token a uno de larga duración con el [Depurador de tokens](https://developers.facebook.com/tools/debug/accesstoken) tocando **Ampliar token de acceso**.
4. En Apps Script agregá la propiedad `META_TOKEN` con ese token.
5. Para cada cliente, en el tablero, **Menciones › Escucha automática › Configurar**, cargá
   - el **id de la página de Facebook**, que aparece en la página, sección **Información › Transparencia de la página**;
   - el **id de la cuenta de Instagram**, que se obtiene en el Explorador con la consulta `me/accounts?fields=instagram_business_account`.

El token de larga duración vence a los 60 días. El tablero muestra la fuente en rojo cuando vence, y se renueva repitiendo los pasos 2 a 4.

---

## Parte 3 · X (pago)

1. Contratá un plan de la [API de X](https://developer.x.com) que incluya búsqueda reciente. Consultá el precio vigente antes de contratar.
2. Copiá el **Bearer Token** de tu app.
3. En Apps Script agregá la propiedad `X_BEARER` con ese token.

---

## Parte 4 · TikTok y redes de terceros (pago por uso)

Facebook, Instagram y TikTok no permiten buscar publicaciones de terceros con sus herramientas oficiales. Para eso se usa un servicio externo. El robot ya viene preparado para [Apify](https://apify.com), que cobra según lo que se usa y trae un crédito mensual gratis.

1. Creá una cuenta en Apify.
2. Copiá tu token desde **Settings › Integrations**.
3. En Apps Script agregá la propiedad `APIFY_TOKEN`.

Por defecto busca videos de TikTok. Para sumar búsquedas de Facebook o Instagram de terceros hay que elegir los "actores" de Apify que se van a usar. Pedímelo cuando quieras activarlo y lo configuramos juntos.

---

## Preguntas frecuentes

**¿Cuánto cuesta?** Las partes 1 y 2 son gratis. Gemini tiene un uso gratuito diario que alcanza para varios clientes. Con la clave gratuita Google puede usar lo que se envía para mejorar sus modelos. Son publicaciones públicas, pero si querés evitarlo activá la facturación en tu proyecto de Google AI Studio.

**¿Puede borrar o cambiar lo que cargó el equipo?** No. El robot solo agrega menciones nuevas. Si una mención ya existe, no la toca.

**¿Qué pasa si una fuente falla?** Las demás siguen funcionando. El tablero muestra esa fuente en rojo con el motivo.

**¿Cómo lo apago?** En Apps Script, menú **Activadores** (el reloj de la izquierda), borrá los tres activadores. Para pausar un solo cliente usá **Configurar** en el tablero.

**¿Cómo veo qué hizo?** En Apps Script, menú **Ejecuciones**, aparece cada corrida con su registro.
